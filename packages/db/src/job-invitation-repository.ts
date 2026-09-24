import { createHash, randomUUID } from "node:crypto";

import {
  JOB_INVITATION_DEFAULT_ACTIVE_LIMIT,
  JOB_INVITATION_DECLINE_REASONS,
  JOB_INVITATION_STATES,
  JOB_REQUEST_CONTENT_SECTION_KEYS,
  JobInvitationIdempotencyError,
  assertCloseJobInvitationInput,
  assertRespondToJobInvitationInput,
  assertSendJobInvitationInput,
  normalizeJobRequestContentSection,
  transitionJobInvitation,
  type CloseJobInvitationInput,
  type CraftsmanProfileId,
  type CustomerProfileId,
  type JobInvitation,
  type JobInvitationCommandResult,
  type JobInvitationDeclineReason,
  type JobInvitationId,
  type JobInvitationDetail,
  type JobInvitationListItem,
  type JobInvitationPersistence,
  type JobInvitationState,
  type JobRequestBudgetContent,
  type JobRequestContentPayload,
  type JobRequestCoreContent,
  type JobRequestDetailsContent,
  type JobRequestId,
  type JobRequestLocationContent,
  type JobRequestMediaContent,
  type JobRequestTimingContent,
  type RespondToJobInvitationInput,
  type SendJobInvitationInput,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type CommandKind =
  | "CRAFTSMAN_WITHDRAW"
  | "CUSTOMER_STOP"
  | "CUSTOMER_WITHDRAW"
  | "DECLINE"
  | "ENGAGE"
  | "EXPIRE"
  | "SEND";

interface CommandRow {
  readonly actorUserId: string | null;
  readonly commandKind: string;
  readonly declineNote: string | null;
  readonly declineReason: string | null;
  readonly invitationId: string;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

interface InvitationRow {
  readonly changedAt: Date;
  readonly craftsmanProfileId: string;
  readonly customerProfileId: string;
  readonly declineNote: string | null;
  readonly declineReason: string | null;
  readonly engagedAt: Date | null;
  readonly expiresAt: Date;
  readonly id: string;
  readonly jobRequestId: string;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly revision: number;
  readonly sentAt: Date;
  readonly state: string;
}

interface InvitationListRow {
  readonly changedAt: Date;
  readonly craftsmanDisplayName: string | null;
  readonly customerProfileId: string;
  readonly expiresAt: Date;
  readonly id: string;
  readonly jobRequestId: string;
  readonly perspective: string;
  readonly requestTitle: string | null;
  readonly revision: number;
  readonly state: string;
}

interface InvitationDetailContextRow extends InvitationListRow {
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}

interface InvitationSectionRow {
  readonly payload: unknown;
  readonly sectionKey: string;
  readonly sectionSchemaVersion: number;
}

interface CustomerTrustRow {
  readonly permittedReviewComments: string[];
  readonly rating: number | string | null;
  readonly reviewCount: number;
}

interface InvitationCustomerTrust {
  readonly permittedReviewComments: readonly string[];
  readonly rating: number | null;
  readonly reviewCount: number;
}

export function createJobInvitationRepository(
  sql: Sql,
): JobInvitationPersistence {
  return Object.freeze({
    closeOwned(input: CloseJobInvitationInput) {
      assertCloseJobInvitationInput(input);
      return executeActorCommand(
        sql,
        input.action === "WITHDRAW" ? "CUSTOMER_WITHDRAW" : "CUSTOMER_STOP",
        input,
        null,
        null,
      );
    },
    async expirePending(): Promise<readonly JobInvitationId[]> {
      const candidates = await sql.begin(
        (transaction) =>
          transaction<
            Array<{
              readonly id: JobInvitationId;
              readonly jobRequestId: JobRequestId;
              readonly revision: number;
            }>
          >`
          SELECT current.id, current.revision,
            identity.job_request_id AS "jobRequestId"
          FROM current_job_invitations current
          JOIN job_invitations identity ON identity.id = current.id
          WHERE current.state = 'PENDING'
            AND current.expires_at <= clock_timestamp()
          ORDER BY current.expires_at, current.id
          LIMIT 100
        `,
      );
      const expired: JobInvitationId[] = [];
      for (const candidate of candidates) {
        const applied = await sql.begin(async (transaction) => {
          await lockNotificationRequest(transaction, candidate.jobRequestId);
          const context = await lockInvitationContext(
            transaction,
            candidate.id,
          );
          if (
            context === null ||
            context.state !== "PENDING" ||
            context.revision !== candidate.revision ||
            context.expiresAt.valueOf() > context.databaseNow.valueOf()
          ) {
            return false;
          }
          const commandId = randomUUID();
          const fingerprint = commandFingerprint("EXPIRE", {
            actorUserId: null,
            declineNote: null,
            declineReason: null,
            expectedRevision: candidate.revision,
            invitationId: candidate.id,
          });
          await insertCommand(transaction, {
            actorUserId: null,
            commandId,
            commandKind: "EXPIRE",
            declineNote: null,
            declineReason: null,
            expectedRevision: candidate.revision,
            fingerprint,
            invitationId: candidate.id,
            systemInitiated: true,
            targetState: "EXPIRED",
          });
          await insertRevision(transaction, {
            commandId,
            invitationId: candidate.id,
            revision: candidate.revision + 1,
            state: "EXPIRED",
          });
          return true;
        });
        if (applied) expired.push(candidate.id);
      }
      return Object.freeze(expired);
    },
    async listOwned(input: {
      readonly actorUserId: UserId;
      readonly jobRequestId?: JobRequestId;
      readonly limit: number;
    }): Promise<readonly JobInvitationListItem[]> {
      assertReadListInput(input);
      const rows = await sql<InvitationListRow[]>`
        SELECT invitation.id,
          invitation.job_request_id AS "jobRequestId",
          invitation.customer_profile_id AS "customerProfileId",
          current.revision, current.state::text AS state,
          current.changed_at AS "changedAt", current.expires_at AS "expiresAt",
          CASE WHEN customer.owner_user_id = ${input.actorUserId}
            THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END AS perspective,
          core.payload ->> 'title' AS "requestTitle",
          CASE WHEN craftsman.profile_type = 'COMPANY'
            THEN craftsman.official_company_name
            ELSE COALESCE(craftsman.nickname,
              NULLIF(concat_ws(' ', craftsman.real_first_name,
                craftsman.real_last_name), ''))
          END AS "craftsmanDisplayName"
        FROM job_invitations invitation
        JOIN current_job_invitations current ON current.id = invitation.id
        JOIN customer_profiles customer
          ON customer.id = invitation.customer_profile_id
        JOIN craftsman_profiles craftsman
          ON craftsman.id = invitation.craftsman_profile_id
        JOIN users actor ON actor.id = ${input.actorUserId}
          AND actor.account_state = 'ACTIVE'
        LEFT JOIN LATERAL (
          SELECT section.payload
          FROM job_request_active_section_revisions section
          WHERE section.job_request_id = invitation.job_request_id
            AND section.section_key = 'request.core'
            AND section.content_revision <= invitation.request_content_revision
          ORDER BY section.content_revision DESC LIMIT 1
        ) core ON true
        WHERE (customer.owner_user_id = actor.id
            OR craftsman.owner_user_id = actor.id)
          AND (${input.jobRequestId ?? null}::uuid IS NULL
            OR invitation.job_request_id = ${input.jobRequestId ?? null})
        ORDER BY current.changed_at DESC, invitation.id DESC
        LIMIT ${input.limit}
      `;
      return Object.freeze(rows.map(toListItem));
    },
    async readOwned(input: {
      readonly actorUserId: UserId;
      readonly invitationId: JobInvitationId;
      readonly requestContentRevision?: number;
    }): Promise<JobInvitationDetail | null> {
      assertReadDetailInput(input);
      return sql.begin(async (transaction) => {
        const activeActors = await transaction`
          SELECT id FROM users
          WHERE id = ${input.actorUserId} AND account_state = 'ACTIVE'
          FOR UPDATE
        `;
        if (activeActors.length !== 1) return null;
        const [context] = await transaction<InvitationDetailContextRow[]>`
          SELECT invitation.id,
            invitation.job_request_id AS "jobRequestId",
            invitation.customer_profile_id AS "customerProfileId",
            invitation.request_content_revision AS "requestContentRevision",
            invitation.request_visible_version AS "requestVisibleVersion",
            current.revision, current.state::text AS state,
            current.changed_at AS "changedAt", current.expires_at AS "expiresAt",
            CASE WHEN customer.owner_user_id = ${input.actorUserId}
              THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END AS perspective,
            core.payload ->> 'title' AS "requestTitle",
            CASE WHEN craftsman.profile_type = 'COMPANY'
              THEN craftsman.official_company_name
              ELSE COALESCE(craftsman.nickname,
                NULLIF(concat_ws(' ', craftsman.real_first_name,
                  craftsman.real_last_name), ''))
            END AS "craftsmanDisplayName"
          FROM job_invitations invitation
          JOIN current_job_invitations current ON current.id = invitation.id
          JOIN customer_profiles customer
            ON customer.id = invitation.customer_profile_id
          JOIN craftsman_profiles craftsman
            ON craftsman.id = invitation.craftsman_profile_id
          JOIN users actor ON actor.id = ${input.actorUserId}
            AND actor.account_state = 'ACTIVE'
          LEFT JOIN LATERAL (
            SELECT section.payload
            FROM job_request_active_section_revisions section
            WHERE section.job_request_id = invitation.job_request_id
              AND section.section_key = 'request.core'
              AND section.content_revision <= invitation.request_content_revision
            ORDER BY section.content_revision DESC LIMIT 1
          ) core ON true
          WHERE invitation.id = ${input.invitationId}
            AND (customer.owner_user_id = actor.id
              OR craftsman.owner_user_id = actor.id)
          FOR UPDATE OF invitation, customer, craftsman
        `;
        if (context === undefined) return null;
        let displayedContentRevision = context.requestContentRevision;
        let displayedVisibleVersion = context.requestVisibleVersion;
        if (input.requestContentRevision !== undefined) {
          const [version] = await transaction<
            Array<{ readonly visibleVersion: number }>
          >`
            SELECT visible_version AS "visibleVersion"
            FROM job_request_active_content_revisions
            WHERE job_request_id = ${context.jobRequestId}
              AND content_revision = ${input.requestContentRevision}
              AND (
                ${context.perspective === "CUSTOMER"}
                OR content_revision = ${context.requestContentRevision}
                OR EXISTS (
                  SELECT 1
                  FROM job_request_material_update_entitlements entitlement
                  WHERE entitlement.job_request_id = ${context.jobRequestId}
                    AND entitlement.invitation_id = ${input.invitationId}
                    AND entitlement.recipient_user_id = ${input.actorUserId}
                    AND entitlement.request_content_revision
                      = ${input.requestContentRevision}
                )
              )
          `;
          if (
            version === undefined ||
            !Number.isSafeInteger(version.visibleVersion) ||
            version.visibleVersion < 1
          ) {
            return null;
          }
          displayedContentRevision = input.requestContentRevision;
          displayedVisibleVersion = version.visibleVersion;
        }
        const sections = await transaction<InvitationSectionRow[]>`
          SELECT DISTINCT ON (section.section_key)
            section.section_key AS "sectionKey",
            section.section_schema_version AS "sectionSchemaVersion",
            section.payload
          FROM job_request_active_section_revisions section
          WHERE section.job_request_id = ${context.jobRequestId}
            AND section.content_revision <= ${displayedContentRevision}
          ORDER BY section.section_key, section.content_revision DESC
        `;
        const customerTrust =
          context.perspective === "CRAFTSMAN" &&
          (context.state === "PENDING" || context.state === "ENGAGED")
            ? await readInvitationCustomerTrust(
                transaction,
                context.customerProfileId,
              )
            : emptyInvitationCustomerTrust();
        const provisional = toDetail(
          context,
          sections,
          null,
          displayedContentRevision,
          displayedVisibleVersion,
          customerTrust,
        );
        const [distance] = await transaction<
          Array<{ readonly approximateDistanceKm: number }>
        >`
          SELECT round(ST_Distance(
            origin.centroid::geography, base.centroid::geography
          ) / 1000.0)::integer AS "approximateDistanceKm"
          FROM job_invitations invitation
          JOIN current_craftsman_service_areas area
            ON area.craftsman_profile_id = invitation.craftsman_profile_id
          JOIN location_municipalities base
            ON base.code = area.base_municipality_code AND base.is_active
          JOIN location_municipalities origin
            ON origin.code = ${provisional.request.municipalityCode}
            AND origin.is_active
          WHERE invitation.id = ${input.invitationId}
        `;
        const approximateDistanceKm = distance?.approximateDistanceKm ?? null;
        if (
          approximateDistanceKm !== null &&
          (!Number.isSafeInteger(approximateDistanceKm) ||
            approximateDistanceKm < 0 ||
            approximateDistanceKm > 1_000)
        ) {
          throw new Error("Corrupt invitation distance fact.");
        }
        return Object.freeze({
          ...provisional,
          request: Object.freeze({
            ...provisional.request,
            approximateDistanceKm,
          }),
        });
      });
    },
    respondOwned(input: RespondToJobInvitationInput) {
      assertRespondToJobInvitationInput(input);
      return executeActorCommand(
        sql,
        input.action === "WITHDRAW" ? "CRAFTSMAN_WITHDRAW" : input.action,
        input,
        input.declineReason ?? null,
        input.declineNote ?? null,
      );
    },
    async sendOwned(
      input: SendJobInvitationInput,
    ): Promise<JobInvitationCommandResult> {
      assertSendJobInvitationInput(input);
      return sql.begin(async (transaction) => {
        await lockNotificationRequest(transaction, input.jobRequestId);
        const customerProfileId = await lockVerifiedCustomer(
          transaction,
          input.actorUserId,
        );
        if (customerProfileId === null) return accountNotEligible();
        await lockCommand(transaction, input.commandId);
        const fingerprint = commandFingerprint("SEND", {
          actorUserId: input.actorUserId,
          craftsmanProfileId: input.craftsmanProfileId,
          jobRequestId: input.jobRequestId,
        });
        const replay = await replayCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "SEND",
          declineNote: null,
          declineReason: null,
          fingerprint,
        });
        if (replay !== null) return replay;
        await transaction`
          SELECT pg_advisory_xact_lock(hashtextextended(
            ${`${input.jobRequestId}:${input.craftsmanProfileId}`}, 41007
          ))
        `;
        const request = await lockActiveRequest(
          transaction,
          input.jobRequestId,
          customerProfileId,
        );
        if (request === null) return notFound();
        const existing = await transaction`
          SELECT id FROM job_invitations
          WHERE job_request_id = ${input.jobRequestId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
        `;
        if (existing.length > 0) {
          return Object.freeze({ status: "ALREADY_INVITED" as const });
        }
        if (
          !(await targetIsEligible(
            transaction,
            input.craftsmanProfileId,
            input.actorUserId,
            input.jobRequestId,
          ))
        ) {
          return Object.freeze({ status: "TARGET_NOT_ELIGIBLE" as const });
        }
        const policy = await lockInvitationLimit(
          transaction,
          input.jobRequestId,
        );
        if (policy.count >= policy.limit) {
          return Object.freeze({
            activeLimit: policy.limit,
            status: "ACTIVE_LIMIT_REACHED" as const,
          });
        }
        const invitationId = randomUUID() as JobInvitationId;
        await transaction`
          INSERT INTO job_invitations (
            id, job_request_id, customer_profile_id, craftsman_profile_id,
            request_content_revision, request_visible_version
          ) VALUES (
            ${invitationId}, ${input.jobRequestId}, ${customerProfileId},
            ${input.craftsmanProfileId}, ${request.contentRevision},
            ${request.visibleVersion}
          )
        `;
        await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "SEND",
          declineNote: null,
          declineReason: null,
          expectedRevision: 0,
          fingerprint,
          invitationId,
          systemInitiated: false,
          targetState: "PENDING",
        });
        await insertRevision(transaction, {
          commandId: input.commandId,
          invitationId,
          revision: 1,
          state: "PENDING",
        });
        return applied(transaction, invitationId, 1);
      });
    },
  });
}

async function executeActorCommand(
  sql: Sql,
  kind: Exclude<CommandKind, "EXPIRE" | "SEND">,
  input: CloseJobInvitationInput | RespondToJobInvitationInput,
  declineReason: JobInvitationDeclineReason | null,
  declineNote: string | null,
): Promise<JobInvitationCommandResult> {
  return sql.begin(async (transaction) => {
    const jobRequestId = await resolveInvitationRequestId(
      transaction,
      input.invitationId,
    );
    if (jobRequestId === null) return notFound();
    await lockNotificationRequest(transaction, jobRequestId);
    if (!(await actorIsVerified(transaction, input.actorUserId))) {
      return accountNotEligible();
    }
    await lockCommand(transaction, input.commandId);
    const fingerprint = commandFingerprint(kind, {
      actorUserId: input.actorUserId,
      declineNote,
      declineReason,
      expectedRevision: input.expectedRevision,
      invitationId: input.invitationId,
    });
    const replay = await replayCommand(transaction, {
      actorUserId: input.actorUserId,
      commandId: input.commandId,
      commandKind: kind,
      declineNote,
      declineReason,
      fingerprint,
    });
    if (replay !== null) return replay;
    const context = await lockInvitationContext(
      transaction,
      input.invitationId,
    );
    if (context === null) return notFound();
    const customerCommand =
      kind === "CUSTOMER_STOP" || kind === "CUSTOMER_WITHDRAW";
    if (
      (customerCommand && context.customerOwnerId !== input.actorUserId) ||
      (!customerCommand && context.craftsmanOwnerId !== input.actorUserId)
    ) {
      return notFound();
    }
    if (context.revision !== input.expectedRevision) {
      return Object.freeze({
        currentRevision: context.revision,
        status: "STALE_REVISION" as const,
      });
    }
    if (
      context.state === "PENDING" &&
      context.expiresAt.valueOf() <= context.databaseNow.valueOf()
    ) {
      return Object.freeze({ status: "INVALID_TRANSITION" as const });
    }
    const target = transitionJobInvitation(context.state, kind);
    if (target === null) {
      return Object.freeze({ status: "INVALID_TRANSITION" as const });
    }
    await insertCommand(transaction, {
      actorUserId: input.actorUserId,
      commandId: input.commandId,
      commandKind: kind,
      declineNote,
      declineReason,
      expectedRevision: input.expectedRevision,
      fingerprint,
      invitationId: input.invitationId,
      systemInitiated: false,
      targetState: target,
    });
    await insertRevision(transaction, {
      commandId: input.commandId,
      invitationId: input.invitationId,
      revision: input.expectedRevision + 1,
      state: target,
    });
    return applied(transaction, input.invitationId, input.expectedRevision + 1);
  });
}

async function resolveInvitationRequestId(
  sql: TransactionSql,
  invitationId: JobInvitationId,
): Promise<JobRequestId | null> {
  const [row] = await sql<{ readonly jobRequestId: string }[]>`
    SELECT job_request_id AS "jobRequestId"
    FROM job_invitations
    WHERE id = ${invitationId}
  `;
  return row === undefined ? null : (row.jobRequestId as JobRequestId);
}

async function lockNotificationRequest(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${jobRequestId}::text, 41007)
    )
  `;
}

async function lockVerifiedCustomer(sql: TransactionSql, actorUserId: UserId) {
  const [row] = await sql<{ readonly customerProfileId: string }[]>`
    SELECT customer.id AS "customerProfileId"
    FROM users actor
    JOIN auth_credentials credential ON credential.user_id = actor.id
    JOIN customer_profiles customer ON customer.owner_user_id = actor.id
    WHERE actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    FOR UPDATE OF actor, credential, customer
  `;
  return row === undefined
    ? null
    : (row.customerProfileId as CustomerProfileId);
}

async function actorIsVerified(sql: TransactionSql, actorUserId: UserId) {
  const rows = await sql`
    SELECT actor.id FROM users actor
    JOIN auth_credentials credential ON credential.user_id = actor.id
    WHERE actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    FOR UPDATE OF actor, credential
  `;
  return rows.length === 1;
}

async function lockActiveRequest(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  customerProfileId: CustomerProfileId,
) {
  const [row] = await sql<
    { readonly contentRevision: number; readonly visibleVersion: number }[]
  >`
    SELECT content.content_revision AS "contentRevision",
      content.visible_version AS "visibleVersion"
    FROM job_requests request
    JOIN current_job_requests current ON current.id = request.id
      AND current.state::text = 'ACTIVE'
    JOIN current_job_request_active_content_versions content
      ON content.job_request_id = request.id
    WHERE request.id = ${jobRequestId}
      AND request.customer_profile_id = ${customerProfileId}
    FOR UPDATE OF request
  `;
  return row ?? null;
}

async function targetIsEligible(
  sql: TransactionSql,
  profileId: CraftsmanProfileId,
  customerActorId: UserId,
  jobRequestId: JobRequestId,
) {
  const rows = await sql`
    SELECT publication.craftsman_profile_id
    FROM current_craftsman_profile_publications publication
    JOIN current_job_request_active_sections core
      ON core.job_request_id = ${jobRequestId}
     AND core.section_key = 'request.core'
    WHERE publication.craftsman_profile_id = ${profileId}
      AND publication.effectively_public
      AND publication.owner_user_id <> ${customerActorId}
      AND NOT EXISTS (
        SELECT 1 FROM current_credential_qualification_policies policy
        WHERE policy.profession_code = core.payload ->> 'primaryProfessionCode'
          AND policy.requirement = 'REQUIRED'
          AND NOT EXISTS (
            SELECT 1 FROM current_searchable_craftsman_credentials credential
            WHERE credential.craftsman_profile_id = ${profileId}
              AND credential.profession_code = policy.profession_code
              AND credential.credential_type_code = policy.credential_type_code
          )
      )
  `;
  return rows.length === 1;
}

async function lockInvitationLimit(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
) {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${jobRequestId}::text, 41007))
  `;
  const [row] = await sql<{ readonly count: number; readonly limit: number }[]>`
    SELECT policy.active_invitation_limit AS limit,
      count(current.id)::integer AS count
    FROM job_invitation_runtime_policy policy
    LEFT JOIN current_job_invitations current ON current.job_request_id = ${jobRequestId}
      AND current.state IN ('PENDING', 'ENGAGED')
    GROUP BY policy.active_invitation_limit
  `;
  if (row === undefined) throw new Error("Invitation runtime policy missing.");
  return row;
}

async function lockInvitationContext(
  sql: TransactionSql,
  invitationId: JobInvitationId,
) {
  const [row] = await sql<
    Array<{
      readonly craftsmanOwnerId: string;
      readonly customerOwnerId: string;
      readonly databaseNow: Date;
      readonly expiresAt: Date;
      readonly revision: number;
      readonly state: JobInvitationState;
    }>
  >`
    SELECT craftsman.owner_user_id AS "craftsmanOwnerId",
      customer.owner_user_id AS "customerOwnerId", current.revision,
      current.state, current.expires_at AS "expiresAt",
      clock_timestamp() AS "databaseNow"
    FROM job_invitations invitation
    JOIN current_job_invitations current ON current.id = invitation.id
    JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
    JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
    WHERE invitation.id = ${invitationId}
    FOR UPDATE OF invitation, customer, craftsman
  `;
  return row ?? null;
}

async function replayCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly commandKind: Exclude<CommandKind, "EXPIRE">;
    readonly declineNote: string | null;
    readonly declineReason: JobInvitationDeclineReason | null;
    readonly fingerprint: string;
  },
): Promise<JobInvitationCommandResult | null> {
  const [row] = await sql<CommandRow[]>`
    SELECT actor_user_id AS "actorUserId", command_kind::text AS "commandKind",
      decline_note AS "declineNote", decline_reason::text AS "declineReason",
      invitation_id AS "invitationId", payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision"
    FROM job_invitation_commands WHERE command_id = ${input.commandId}
  `;
  if (row === undefined) return null;
  if (
    row.actorUserId !== input.actorUserId ||
    row.commandKind !== input.commandKind ||
    row.declineNote !== input.declineNote ||
    row.declineReason !== input.declineReason ||
    row.payloadFingerprint !== input.fingerprint
  ) {
    throw new JobInvitationIdempotencyError(
      "Job invitation command id was reused for another intent.",
    );
  }
  const historical = await selectRevision(
    sql,
    row.invitationId as JobInvitationId,
    row.resultingRevision,
  );
  if (historical === null) throw new Error("Invitation replay effect missing.");
  return Object.freeze({
    invitation: historical,
    status: "DEDUPLICATED" as const,
  });
}

async function applied(
  sql: TransactionSql,
  invitationId: JobInvitationId,
  revision: number,
): Promise<JobInvitationCommandResult> {
  const result = await selectRevision(sql, invitationId, revision);
  if (result === null) throw new Error("Invitation command effect missing.");
  return Object.freeze({ invitation: result, status: "APPLIED" as const });
}

async function selectRevision(
  sql: TransactionSql,
  invitationId: JobInvitationId,
  revision: number,
): Promise<JobInvitation | null> {
  const [row] = await sql<InvitationRow[]>`
    SELECT invitation.id, invitation.job_request_id AS "jobRequestId",
      invitation.customer_profile_id AS "customerProfileId",
      invitation.craftsman_profile_id AS "craftsmanProfileId",
      invitation.request_content_revision AS "requestContentRevision",
      invitation.request_visible_version AS "requestVisibleVersion",
      stored.revision, stored.state::text AS state,
      stored.changed_at AS "changedAt", stored.sent_at AS "sentAt",
      stored.expires_at AS "expiresAt", stored.engaged_at AS "engagedAt",
      stored.decline_reason::text AS "declineReason",
      stored.decline_note AS "declineNote"
    FROM job_invitations invitation
    JOIN job_invitation_revisions stored ON stored.invitation_id = invitation.id
    WHERE invitation.id = ${invitationId} AND stored.revision = ${revision}
  `;
  return row === undefined ? null : toInvitation(row);
}

async function insertCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId | null;
    readonly commandId: string;
    readonly commandKind: CommandKind;
    readonly declineNote: string | null;
    readonly declineReason: JobInvitationDeclineReason | null;
    readonly expectedRevision: number;
    readonly fingerprint: string;
    readonly invitationId: JobInvitationId;
    readonly systemInitiated: boolean;
    readonly targetState: JobInvitationState;
  },
) {
  await sql`
    INSERT INTO job_invitation_commands (
      command_id, invitation_id, actor_user_id, command_kind,
      expected_revision, resulting_revision, target_state, system_initiated,
      decline_reason, decline_note, payload_fingerprint
    ) VALUES (
      ${input.commandId}, ${input.invitationId}, ${input.actorUserId},
      ${input.commandKind}, ${input.expectedRevision},
      ${input.expectedRevision + 1}, ${input.targetState},
      ${input.systemInitiated}, ${input.declineReason}, ${input.declineNote},
      ${input.fingerprint}
    )
  `;
}

async function insertRevision(
  sql: TransactionSql,
  input: {
    readonly commandId: string;
    readonly invitationId: JobInvitationId;
    readonly revision: number;
    readonly state: JobInvitationState;
  },
) {
  await sql`
    INSERT INTO job_invitation_revisions (
      invitation_id, revision, command_id, state, changed_at, sent_at,
      expires_at, engaged_at, decline_reason, decline_note
    ) VALUES (
      ${input.invitationId}, ${input.revision}, ${input.commandId},
      ${input.state}, clock_timestamp(), clock_timestamp(),
      clock_timestamp(), NULL, NULL, NULL
    )
  `;
}

function toInvitation(row: InvitationRow): JobInvitation {
  if (
    !JOB_INVITATION_STATES.some((state) => state === row.state) ||
    !(row.changedAt instanceof Date) ||
    !(row.sentAt instanceof Date) ||
    !(row.expiresAt instanceof Date) ||
    (row.engagedAt !== null && !(row.engagedAt instanceof Date)) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.requestContentRevision) ||
    row.requestContentRevision < 1 ||
    !Number.isSafeInteger(row.requestVisibleVersion) ||
    row.requestVisibleVersion < 1 ||
    !isUuid(row.id) ||
    !isUuid(row.jobRequestId) ||
    !isUuid(row.customerProfileId) ||
    !isUuid(row.craftsmanProfileId) ||
    (row.declineReason !== null &&
      !JOB_INVITATION_DECLINE_REASONS.some(
        (reason) => reason === row.declineReason,
      )) ||
    (row.declineNote !== null &&
      (row.declineNote !== row.declineNote.trim() ||
        row.declineNote.length < 1 ||
        row.declineNote.length > 500)) ||
    (row.state === "PENDING" && row.engagedAt !== null) ||
    (row.state === "ENGAGED" && row.engagedAt === null) ||
    ((row.state === "DECLINED" || row.state === "EXPIRED") &&
      row.engagedAt !== null) ||
    (row.state !== "DECLINED" &&
      (row.declineReason !== null || row.declineNote !== null))
  )
    throw new Error("Corrupt job invitation row.");
  return Object.freeze({
    changedAt: row.changedAt,
    craftsmanProfileId: row.craftsmanProfileId as CraftsmanProfileId,
    customerProfileId: row.customerProfileId as CustomerProfileId,
    declineNote: row.declineNote,
    declineReason: row.declineReason as JobInvitationDeclineReason | null,
    engagedAt: row.engagedAt,
    expiresAt: row.expiresAt,
    id: row.id as JobInvitationId,
    jobRequestId: row.jobRequestId as JobRequestId,
    requestContentRevision: row.requestContentRevision,
    requestVisibleVersion: row.requestVisibleVersion,
    revision: row.revision,
    sentAt: row.sentAt,
    state: row.state as JobInvitationState,
  });
}

function toListItem(row: InvitationListRow): JobInvitationListItem {
  if (
    !isUuid(row.id) ||
    !isUuid(row.jobRequestId) ||
    !isUuid(row.customerProfileId) ||
    !JOB_INVITATION_STATES.some((state) => state === row.state) ||
    (row.perspective !== "CUSTOMER" && row.perspective !== "CRAFTSMAN") ||
    !(row.changedAt instanceof Date) ||
    !(row.expiresAt instanceof Date) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  ) {
    throw new Error("Corrupt job invitation list row.");
  }
  const counterpartDisplayName =
    row.perspective === "CUSTOMER"
      ? safeDisplayName(row.craftsmanDisplayName, "Remeselník")
      : `Zákazník ${row.customerProfileId.slice(0, 8).toUpperCase()}`;
  return Object.freeze({
    changedAt: row.changedAt,
    counterpartDisplayName,
    expiresAt: row.expiresAt,
    id: row.id as JobInvitationId,
    jobRequestId: row.jobRequestId as JobRequestId,
    perspective: row.perspective,
    requestTitle: safeDisplayName(row.requestTitle, "Dopyt"),
    revision: row.revision,
    state: row.state as JobInvitationState,
  });
}

function toDetail(
  context: InvitationDetailContextRow,
  rows: readonly InvitationSectionRow[],
  approximateDistanceKm: number | null,
  displayedRequestContentRevision: number,
  displayedRequestVisibleVersion: number,
  customerTrust: InvitationCustomerTrust,
): JobInvitationDetail {
  if (
    !Number.isSafeInteger(context.requestContentRevision) ||
    context.requestContentRevision < 1 ||
    !Number.isSafeInteger(context.requestVisibleVersion) ||
    context.requestVisibleVersion < 1
  ) {
    throw new Error("Corrupt invitation request-version provenance.");
  }
  const sections = new Map<string, JobRequestContentPayload>(
    rows.map((row) => {
      if (
        !JOB_REQUEST_CONTENT_SECTION_KEYS.some((key) => key === row.sectionKey)
      ) {
        throw new Error("Corrupt invitation request section key.");
      }
      const normalized = normalizeJobRequestContentSection({
        key: row.sectionKey,
        payload: row.payload,
        schemaVersion: row.sectionSchemaVersion,
      });
      return [normalized.key, normalized.payload] as const;
    }),
  );
  const core = sections.get("request.core") as
    JobRequestCoreContent | undefined;
  const location = sections.get("request.location") as
    JobRequestLocationContent | undefined;
  if (
    core?.description === null ||
    core === undefined ||
    core.primaryProfessionCode === null ||
    location?.municipalityCode === null ||
    location === undefined
  ) {
    throw new Error("Invitation references an invalid request brief.");
  }
  const timing = (sections.get("request.timing") ?? {
    completionDeadline: null,
    endsOn: null,
    mode: null,
    startsOn: null,
  }) as JobRequestTimingContent;
  const budget = (sections.get("request.budget") ?? {
    currency: "EUR",
    maximumAmountCents: null,
    minimumAmountCents: null,
    mode: null,
  }) as JobRequestBudgetContent;
  const details = (sections.get("request.details") ?? {
    approximateQuantity: null,
    customRequirements: null,
    materialResponsibility: null,
    siteInspection: null,
  }) as JobRequestDetailsContent;
  const media = (sections.get("request.media") ?? {
    documentMediaAssetIds: [],
    photoMediaAssetIds: [],
  }) as JobRequestMediaContent;
  const description = preConfirmationText(core.description);
  return Object.freeze({
    ...toListItem(context),
    competitionDisclosure: "CUSTOMER_MAY_CONTACT_OTHERS" as const,
    customerTrust,
    request: Object.freeze({
      approximateDistanceKm,
      budget: Object.freeze({ ...budget }),
      description:
        description ??
        "Podrobnosti sú skryté do potvrdenia pracovného kontextu.",
      details: Object.freeze({
        ...details,
        customRequirements: preConfirmationText(details.customRequirements),
      }),
      documentMediaAssetIds: Object.freeze([...media.documentMediaAssetIds]),
      municipalityCode: location.municipalityCode,
      photoMediaAssetIds: Object.freeze([...media.photoMediaAssetIds]),
      primaryProfessionCode: core.primaryProfessionCode,
      relatedProfessionCodes: Object.freeze([...core.relatedProfessionCodes]),
      skillCodes: Object.freeze([...core.skillCodes]),
      specializationCode: core.specializationCode,
      timing: Object.freeze({ ...timing }),
      title: preConfirmationText(core.title) ?? "Dopyt",
    }),
    displayedRequestContentRevision,
    displayedRequestVisibleVersion,
    requestContentRevision: context.requestContentRevision,
    requestVisibleVersion: context.requestVisibleVersion,
  });
}

async function readInvitationCustomerTrust(
  sql: TransactionSql,
  customerProfileId: string,
): Promise<InvitationCustomerTrust> {
  const [row] = await sql<CustomerTrustRow[]>`
    WITH per_review AS (
      SELECT review.job_id, review.unlocked_at, review.comment,
        avg((rating.value #>> '{}')::numeric) AS review_score
      FROM current_unlocked_job_main_reviews review
      CROSS JOIN LATERAL jsonb_each(review.ratings) rating
      WHERE review.direction = 'PROVIDER_TO_CUSTOMER'
        AND review.target_kind = 'CUSTOMER_PROFILE'
        AND review.target_profile_id = ${customerProfileId}
        AND jsonb_typeof(rating.value) = 'number'
      GROUP BY review.job_id, review.unlocked_at, review.comment
    ), bounded_comments AS (
      SELECT job_id, unlocked_at, comment
      FROM per_review
      WHERE comment IS NOT NULL
      ORDER BY unlocked_at DESC, job_id DESC
      LIMIT 3
    )
    SELECT round(avg(per_review.review_score), 2)::double precision AS rating,
      count(*)::integer AS "reviewCount",
      COALESCE(
        (SELECT array_agg(comment ORDER BY unlocked_at DESC, job_id DESC)
          FROM bounded_comments),
        ARRAY[]::text[]
      ) AS "permittedReviewComments"
    FROM per_review
  `;
  if (row === undefined) {
    throw new Error("Missing invitation customer trust aggregate.");
  }
  const rating = nullableReviewScore(row.rating);
  if (
    !Number.isSafeInteger(row.reviewCount) ||
    row.reviewCount < 0 ||
    (row.reviewCount === 0 ? rating !== null : rating === null) ||
    !Array.isArray(row.permittedReviewComments) ||
    row.permittedReviewComments.length > 3 ||
    row.permittedReviewComments.some(
      (comment) =>
        typeof comment !== "string" ||
        comment.length < 1 ||
        comment.length > 2_000 ||
        comment.trim() !== comment ||
        [...comment].some((character) => {
          const codePoint = character.codePointAt(0);
          return (
            codePoint !== undefined && (codePoint < 32 || codePoint === 127)
          );
        }),
    )
  ) {
    throw new Error("Corrupt invitation customer trust aggregate.");
  }
  const permittedReviewComments = row.permittedReviewComments.flatMap(
    (comment) => {
      const permitted = preConfirmationText(comment);
      return permitted === null ? [] : [permitted];
    },
  );
  return Object.freeze({
    permittedReviewComments: Object.freeze(permittedReviewComments),
    rating,
    reviewCount: row.reviewCount,
  });
}

function emptyInvitationCustomerTrust(): InvitationCustomerTrust {
  return Object.freeze({
    permittedReviewComments: Object.freeze([]),
    rating: null,
    reviewCount: 0,
  });
}

function nullableReviewScore(value: number | string | null): number | null {
  if (value === null) return null;
  const score = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new Error("Corrupt invitation customer review score.");
  }
  return score;
}

function assertReadListInput(input: {
  readonly actorUserId: UserId;
  readonly jobRequestId?: JobRequestId;
  readonly limit: number;
}): void {
  if (
    !isUuid(input.actorUserId) ||
    (input.jobRequestId !== undefined && !isUuid(input.jobRequestId)) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new TypeError("Invalid job invitation list input.");
  }
}

function assertReadDetailInput(input: {
  readonly actorUserId: UserId;
  readonly invitationId: JobInvitationId;
  readonly requestContentRevision?: number;
}): void {
  if (
    !isUuid(input.actorUserId) ||
    !isUuid(input.invitationId) ||
    (input.requestContentRevision !== undefined &&
      (!Number.isSafeInteger(input.requestContentRevision) ||
        input.requestContentRevision < 1))
  ) {
    throw new TypeError("Invalid job invitation detail input.");
  }
}

function safeDisplayName(value: string | null, fallback: string): string {
  if (
    value === null ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 200 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  ) {
    return fallback;
  }
  return value;
}

function preConfirmationText(value: string | null): string | null {
  if (value === null) return null;
  if (
    /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/iu.test(value) ||
    /(^|[^0-9])(?:\+|00)?[0-9](?:[\s()./-]*[0-9]){6,}([^0-9]|$)/u.test(value) ||
    /(?:https?:\/\/|www\.|\b(?:adresa|ulica|ul\.|číslo domu|súpisné číslo)\b)/iu.test(
      value,
    ) ||
    /\b\d{3}\s?\d{2}\b/u.test(value) ||
    /\b[A-ZÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ][\p{L}-]{2,}\s+\d{1,4}(?:\/\d{1,4})?\b/u.test(
      value,
    )
  ) {
    return null;
  }
  return value;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

async function lockCommand(sql: TransactionSql, commandId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 41007))`;
}

function commandFingerprint(kind: CommandKind, input: object): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, ...input }), "utf8")
    .digest("hex");
}

function accountNotEligible(): JobInvitationCommandResult {
  return Object.freeze({ status: "ACCOUNT_NOT_ELIGIBLE" as const });
}

function notFound(): JobInvitationCommandResult {
  return Object.freeze({ status: "NOT_FOUND" as const });
}

export const JOB_INVITATION_RUNTIME_POLICY_DEFAULT = Object.freeze({
  activeLimit: JOB_INVITATION_DEFAULT_ACTIVE_LIMIT,
});
