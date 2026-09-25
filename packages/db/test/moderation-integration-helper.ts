import { randomUUID } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createModerationRepository } from "../src/moderation-repository.js";
import { createPublicCraftsmanReviewRepository } from "../src/public-craftsman-review-repository.js";
import { createReviewResponseReportRepository } from "../src/review-response-report-repository.js";
import type { ModerationReviewIntegrationFixture } from "./review-response-report-integration-helper.js";

export async function runModerationIntegrationAssertions(
  sql: Sql,
  input: ModerationReviewIntegrationFixture & {
    readonly adminId: UserId;
    readonly privilegedSessionId: string;
  },
): Promise<void> {
  const actor: PrivilegedActor = {
    capabilities: new Set(["admin.reviews.moderate"]),
    mfaAuthenticatedAt: new Date(),
    roles: ["ADMIN"],
    userId: input.adminId,
  };
  const repository = createModerationRepository(sql);
  const [sourceBefore] = await sql<
    Array<{ readonly comment: string | null; readonly ratings: unknown }>
  >`
    SELECT comment, ratings FROM job_main_review_events
    WHERE event_id = ${input.reviewId}
  `;
  if (sourceBefore === undefined)
    throw new Error("Moderation review source fixture missing.");

  const queued = await repository.listQueue({
    actor,
    privilegedSessionId: input.privilegedSessionId,
    state: "OPEN",
  });
  expect(queued).toContainEqual(
    expect.objectContaining({
      reportId: input.reportId,
      state: "OPEN",
      targetId: input.reviewId,
      targetType: "MAIN_REVIEW",
    }),
  );

  const reviewCommandId = randomUUID();
  const workflowReason = "Začatie manuálneho preverenia hlásenej recenzie.";
  await expect(
    repository.startReview({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      commandId: reviewCommandId,
      reportId: input.reportId,
      expectedState: "OPEN",
      reason: workflowReason,
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "UNDER_REVIEW" });
  await expect(
    repository.startReview({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      commandId: reviewCommandId,
      reportId: input.reportId,
      expectedState: "OPEN",
      reason: workflowReason,
    }),
  ).resolves.toMatchObject({
    status: "DEDUPLICATED",
    state: "UNDER_REVIEW",
  });

  const actionShape = {
    actor,
    privilegedSessionId: input.privilegedSessionId,
    reportId: input.reportId,
    expectedState: "UNDER_REVIEW" as const,
    reason: "Overené porušenie pravidiel ochrany osobných údajov.",
    policyCategory: "PERSONAL_DATA_PRIVACY",
    policyReasonCode: "REVIEW_PERSONAL_DATA",
    policyVersion: "D24-ALPHA-1",
    enforcementScope: "CONTENT" as const,
    userFacingReason: "Text recenzie bol skrytý pre ochranu osobných údajov.",
    priorState: { text_visibility: "VISIBLE" },
  };
  await expect(
    repository.hideContent({
      ...actionShape,
      commandId: randomUUID(),
      subjectUserId: input.reporterUserId,
    }),
  ).rejects.toThrow("moderation subject must match target owner");

  const actionId = randomUUID();
  const privateAdminNote =
    "Interná kontrola potvrdila osobný údaj; nezdieľať s používateľom.";
  await expect(
    repository.hideContent({
      ...actionShape,
      commandId: actionId,
      subjectUserId: input.subjectUserId,
      privateAdminNote,
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "ACTIONED" });
  await expect(
    repository.hideContent({
      ...actionShape,
      commandId: actionId,
      subjectUserId: input.subjectUserId,
      privateAdminNote,
    }),
  ).resolves.toMatchObject({ status: "DEDUPLICATED", state: "ACTIONED" });

  const [hidden] = await sql<Array<{ readonly actionId: string }>>`
    SELECT action_id AS "actionId" FROM current_moderation_hidden_targets
    WHERE target_type = 'MAIN_REVIEW' AND target_id = ${input.reviewId}
  `;
  expect(hidden?.actionId).toBe(actionId);
  const [sourceHidden] = await sql<
    Array<{ readonly comment: string | null; readonly ratings: unknown }>
  >`
    SELECT comment, ratings FROM job_main_review_events
    WHERE event_id = ${input.reviewId}
  `;
  expect(sourceHidden).toEqual(sourceBefore);

  const publicWhileHidden = await createPublicCraftsmanReviewRepository(
    sql,
  ).list({ craftsmanProfileId: input.targetProfileId, limit: 20 });
  const hiddenReview = publicWhileHidden?.items.find(
    (item) => item.reviewId === input.reviewId,
  );
  expect(hiddenReview?.comment).toBeNull();
  expect(hiddenReview?.ratings).toBeDefined();

  const detail = await repository.getReport({
    actor,
    privilegedSessionId: input.privilegedSessionId,
    reportId: input.reportId,
    accessId: randomUUID(),
    reason: "Kontrola vykonaného moderátorského zásahu.",
  });
  expect(detail?.actions).toContainEqual(
    expect.objectContaining({ actionId, active: true, action: "HIDE_CONTENT" }),
  );
  const [actionNotification] = await sql<
    Array<{ readonly payload: Record<string, unknown> }>
  >`
    SELECT payload FROM domain_outbox_events
    WHERE event_name = 'moderation.action.applied'
      AND entity_id = ${actionId}
  `;
  expect(actionNotification?.payload).toMatchObject({
    recipient_user_id: input.subjectUserId,
    action_id: actionId,
    action: "HIDE_CONTENT",
    general_reason_category: "PERSONAL_DATA_PRIVACY",
  });
  expect(JSON.stringify(actionNotification?.payload)).not.toContain(
    privateAdminNote,
  );
  expect(JSON.stringify(actionNotification?.payload)).not.toContain(
    actionShape.userFacingReason,
  );

  const appealId = randomUUID();
  await expect(
    repository.submitAppeal({
      actorUserId: input.subjectUserId,
      appealId,
      actionId,
      explanation:
        "Text neobsahuje aktuálne kontaktné údaje; žiadam nové posúdenie.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "OPEN" });
  expect(await repository.listMyActions(input.subjectUserId)).toContainEqual(
    expect.objectContaining({
      actionId,
      active: true,
      appealId,
      appealState: "OPEN",
    }),
  );
  expect(
    await repository.listAppeals({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      state: "OPEN",
    }),
  ).toContainEqual(
    expect.objectContaining({ appealId, actionId, state: "OPEN" }),
  );

  const appeal = await repository.getAppeal({
    actor,
    privilegedSessionId: input.privilegedSessionId,
    appealId,
    accessId: randomUUID(),
    reason: "Manuálne preskúmanie podkladov odvolania.",
  });
  expect(appeal).toMatchObject({
    appealId,
    actionId,
    appellantUserId: input.subjectUserId,
    state: "OPEN",
  });
  const reversalId = randomUUID();
  await expect(
    repository.decideAppeal({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      commandId: reversalId,
      appealId,
      expectedState: "OPEN",
      decision: "REVERSE",
      reason: "Nové podklady nepotvrdili dôvod na ďalšie skrytie textu.",
      policyReasonCode: "RECONSIDERATION_REVERSED",
      policyVersion: "D24-ALPHA-1",
      privateAdminNote: "Obnova po manuálnom preverení podkladov odvolania.",
      userFacingReason: "Po novom posúdení bol text recenzie obnovený.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "REVERSED" });

  expect(await repository.listMyActions(input.subjectUserId)).toContainEqual(
    expect.objectContaining({
      actionId,
      active: false,
      appealId,
      appealState: "REVERSED",
    }),
  );
  const restoredHidden = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count FROM current_moderation_hidden_targets
    WHERE target_type = 'MAIN_REVIEW' AND target_id = ${input.reviewId}
  `;
  expect(restoredHidden[0]?.count).toBe(0);
  const publicAfterReversal = await createPublicCraftsmanReviewRepository(
    sql,
  ).list({ craftsmanProfileId: input.targetProfileId, limit: 20 });
  const restoredReview = publicAfterReversal?.items.find(
    (item) => item.reviewId === input.reviewId,
  );
  expect(restoredReview?.comment).toBe(sourceBefore.comment);
  expect(restoredReview?.ratings).toEqual(hiddenReview?.ratings);

  const [appealNotification] = await sql<
    Array<{ readonly payload: Record<string, unknown> }>
  >`
    SELECT payload FROM domain_outbox_events
    WHERE event_name = 'moderation.appeal.decided'
      AND entity_id = ${appealId}
  `;
  expect(appealNotification?.payload).toEqual({
    recipient_user_id: input.subjectUserId,
    appeal_id: appealId,
    decision: "REVERSE",
  });
  const audits = await sql<Array<{ readonly action: string }>>`
    SELECT action_type AS action FROM audit_events
    WHERE correlation_id IN (${reviewCommandId}, ${actionId}, ${reversalId})
    ORDER BY action_type
  `;
  expect(audits.map((audit) => audit.action)).toEqual([
    "admin.moderation.appeal_reversed",
    "admin.moderation.content_hidden",
    "admin.moderation.review_started",
  ]);

  const [publicBeforeProfileHide] = await sql<
    Array<{
      readonly effectivelyPublic: boolean;
      readonly moderationState: string;
      readonly ownerVisibility: string;
    }>
  >`
    SELECT effectively_public AS "effectivelyPublic",
      moderation_state::text AS "moderationState",
      owner_visibility::text AS "ownerVisibility"
    FROM current_craftsman_profile_publications
    WHERE craftsman_profile_id = ${input.targetProfileId}
  `;
  expect(publicBeforeProfileHide).toEqual({
    effectivelyPublic: true,
    moderationState: "ALLOWED",
    ownerVisibility: "PUBLIC",
  });
  const profileReportId = randomUUID();
  await expect(
    createReviewResponseReportRepository(sql).createReport({
      actorUserId: input.subjectUserId,
      commandId: profileReportId,
      targetType: "CRAFTSMAN_PROFILE",
      targetId: input.targetProfileId,
      reason: "FALSE_IDENTITY",
      details: "Verejná identita profilu vyžaduje manuálne preverenie.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "OPEN" });
  await expect(
    repository.startReview({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      commandId: randomUUID(),
      reportId: profileReportId,
      expectedState: "OPEN",
      reason: "Začatie manuálneho preverenia verejnej identity profilu.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "UNDER_REVIEW" });
  const profileHideId = randomUUID();
  await expect(
    repository.hideContent({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      commandId: profileHideId,
      reportId: profileReportId,
      expectedState: "UNDER_REVIEW",
      reason: "Dočasné ochranné skrytie počas preverenia identity.",
      policyCategory: "IMPERSONATION_MISREPRESENTATION",
      policyReasonCode: "PROFILE_IDENTITY_REVIEW",
      policyVersion: "D24-ALPHA-1",
      subjectUserId: input.reporterUserId,
      enforcementScope: "CONTENT",
      userFacingReason: "Profil bol skrytý počas preverenia verejnej identity.",
      priorState: { owner_visibility: "PUBLIC" },
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "ACTIONED" });
  const [hiddenProfile] = await sql<
    Array<{
      readonly effectivelyPublic: boolean;
      readonly moderationState: string;
      readonly ownerVisibility: string;
    }>
  >`
    SELECT effectively_public AS "effectivelyPublic",
      moderation_state::text AS "moderationState",
      owner_visibility::text AS "ownerVisibility"
    FROM current_craftsman_profile_publications
    WHERE craftsman_profile_id = ${input.targetProfileId}
  `;
  expect(hiddenProfile).toEqual({
    effectivelyPublic: false,
    moderationState: "ALLOWED",
    ownerVisibility: "PUBLIC",
  });
  const searchableWhileHidden = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count
    FROM current_searchable_craftsman_profiles
    WHERE craftsman_profile_id = ${input.targetProfileId}
  `;
  expect(searchableWhileHidden[0]?.count).toBe(0);

  const profileAppealId = randomUUID();
  await expect(
    repository.submitAppeal({
      actorUserId: input.reporterUserId,
      appealId: profileAppealId,
      actionId: profileHideId,
      explanation: "Predkladám vysvetlenie k verejnej identite profilu.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "OPEN" });
  await expect(
    repository.decideAppeal({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      commandId: randomUUID(),
      appealId: profileAppealId,
      expectedState: "OPEN",
      decision: "REVERSE",
      reason: "Doplnené podklady potvrdili legitímnu verejnú identitu.",
      policyReasonCode: "IDENTITY_CONFIRMED",
      policyVersion: "D24-ALPHA-1",
      userFacingReason: "Profil bol po preverení verejnej identity obnovený.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "REVERSED" });
  const [restoredProfile] = await sql<
    Array<{
      readonly effectivelyPublic: boolean;
      readonly moderationState: string;
      readonly ownerVisibility: string;
    }>
  >`
    SELECT effectively_public AS "effectivelyPublic",
      moderation_state::text AS "moderationState",
      owner_visibility::text AS "ownerVisibility"
    FROM current_craftsman_profile_publications
    WHERE craftsman_profile_id = ${input.targetProfileId}
  `;
  expect(restoredProfile).toEqual(publicBeforeProfileHide);
  const searchableAfterReversal = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count
    FROM current_searchable_craftsman_profiles
    WHERE craftsman_profile_id = ${input.targetProfileId}
  `;
  expect(searchableAfterReversal[0]?.count).toBe(1);

  const restrictionReportId = randomUUID();
  await expect(
    createReviewResponseReportRepository(sql).createReport({
      actorUserId: input.subjectUserId,
      commandId: restrictionReportId,
      targetType: "USER_BEHAVIOR",
      targetId: input.reporterUserId,
      reason: "MISLEADING_CLAIM",
      details:
        "Publikačné správanie účtu vyžaduje dočasné manuálne preverenie.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "OPEN" });
  await expect(
    repository.startReview({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      commandId: randomUUID(),
      reportId: restrictionReportId,
      expectedState: "OPEN",
      reason: "Začatie preverenia publikovaných údajov profilu.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "UNDER_REVIEW" });
  const restrictionId = randomUUID();
  await expect(
    repository.restrictFeature({
      actor,
      privilegedSessionId: input.privilegedSessionId,
      commandId: restrictionId,
      reportId: restrictionReportId,
      expectedState: "UNDER_REVIEW",
      reason: "Dočasné obmedzenie publikovania počas manuálneho preverenia.",
      policyCategory: "IMPERSONATION_MISREPRESENTATION",
      policyReasonCode: "PROFILE_PUBLISHING_REVIEW",
      policyVersion: "D24-ALPHA-1",
      subjectUserId: input.reporterUserId,
      enforcementScope: "PUBLISHING",
      userFacingReason:
        "Publikovanie profilu je dočasne obmedzené počas preverenia.",
      priorState: { publishing: "ALLOWED" },
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "ACTIONED" });

  const [scopeAdmission] = await sql<
    Array<{ readonly publishing: boolean; readonly quoting: boolean }>
  >`
    SELECT
      moderation_user_scope_allows(
        ${input.reporterUserId}, 'PUBLISHING'
      ) AS publishing,
      moderation_user_scope_allows(
        ${input.reporterUserId}, 'QUOTING'
      ) AS quoting
  `;
  expect(scopeAdmission).toEqual({ publishing: false, quoting: true });
  await expect(
    sql.begin(async (tx) => {
      await tx`
        INSERT INTO craftsman_availability_commands (
          command_id, craftsman_profile_id, actor_user_id
        ) VALUES (
          ${randomUUID()}, ${input.targetProfileId}, ${input.reporterUserId}
        )
      `;
    }),
  ).rejects.toThrow("active moderation restriction prohibits command");

  await expect(
    sql.begin(async (tx) => {
      await tx`UPDATE moderation_actions
        SET policy_version = 'REWRITTEN' WHERE action_id = ${actionId}`;
    }),
  ).rejects.toThrow(/immutable/iu);
}
