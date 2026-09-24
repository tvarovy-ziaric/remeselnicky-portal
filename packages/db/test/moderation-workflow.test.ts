import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createModerationRepository } from "../src/moderation-repository.js";

const taxonomy = source("0104_moderation_taxonomy.sql");
const workflow = source("0105_moderation_action_appeal_workflow.sql");
const foundation = source("0097_review_responses_and_reports.sql");
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.reviews.moderate"]),
  mfaAuthenticatedAt: new Date(),
  roles: ["ADMIN"],
  userId: randomUUID() as UserId,
};

describe("R4-023 moderation workflow", () => {
  it("commits the complete report taxonomy before using it", () => {
    for (const target of [
      "CRAFTSMAN_PROFILE",
      "PORTFOLIO_PROJECT",
      "MEDIA_ASSET",
      "MAIN_REVIEW",
      "REVIEW_RESPONSE",
      "MESSAGE",
      "CONVERSATION",
      "JOB_ATTACHMENT",
      "JOB_REQUEST",
      "USER_BEHAVIOR",
    ])
      expect(`${foundation}\n${taxonomy}\n${workflow}`).toContain(
        `'${target}'`,
      );
    for (const reason of [
      "SPAM_SCAM",
      "HARASSMENT_ABUSE",
      "PERSONAL_DATA_PRIVACY",
      "INAPPROPRIATE_CONTENT",
      "IMPERSONATION_MISREPRESENTATION",
      "FRAUD",
      "ILLEGAL_SUSPICIOUS_ACTIVITY",
      "CONTACT_BYPASS_ABUSE",
      "OTHER",
    ])
      expect(`${foundation}\n${taxonomy}\n${workflow}`).toContain(
        `'${reason}'`,
      );
  });

  it("keeps claims, decisions, actions, appeals and corrections separate", () => {
    expect(workflow).toContain("CREATE TABLE moderation_admin_commands");
    expect(workflow).toContain("CREATE TABLE moderation_actions");
    expect(workflow).toContain("CREATE TABLE moderation_appeals");
    expect(workflow).toContain("CREATE TABLE moderation_action_corrections");
    expect(workflow).toContain("reporter cannot decide own moderation report");
    expect(workflow).not.toMatch(/report_count\s*[><=]/iu);
    expect(workflow).not.toMatch(/set[_ ](?:moderation[_ ])?status/iu);
  });

  it("requires recent MFA, immutable audit and stable policy provenance", () => {
    expect(workflow).toContain("moderation_admin_session_is_recent");
    expect(workflow).toContain("interval '15 minutes'");
    expect(workflow).toContain("stable moderation policy reason required");
    expect(workflow).toContain("admin.reviews.moderate");
    expect(workflow).toContain(
      "matching immutable moderation command audit event required",
    );
    expect(workflow).toContain("BEFORE UPDATE OR DELETE ON moderation_actions");
    expect(workflow).toContain("appellant cannot decide own moderation appeal");
    expect(workflow).toContain(
      "appeal reduction must materially narrow enforcement",
    );
  });

  it("models granular reversible enforcement without rewriting source content", () => {
    for (const scope of [
      "MESSAGING",
      "PUBLISHING",
      "QUOTING",
      "REVIEWS",
      "ACCOUNT",
    ])
      expect(workflow).toContain(`'${scope}'`);
    expect(workflow).toContain("CREATE VIEW current_moderation_hidden_targets");
    expect(workflow).toContain(
      "CREATE VIEW current_moderation_user_restrictions",
    );
    expect(workflow).toContain(
      "correction.decision IS DISTINCT FROM 'REVERSE'",
    );
    expect(workflow).toContain("current_craftsman_profile_publications");
    expect(workflow).toContain("'CRAFTSMAN_PROFILE', 'MAIN_REVIEW'");
    expect(workflow).not.toMatch(/UPDATE\s+conversation_timeline_entries/iu);
    expect(workflow).not.toMatch(/DELETE\s+FROM\s+job_main_review/iu);
  });

  it("keeps review text hiding distinct from evidence exclusion", () => {
    expect(workflow).toContain("current_moderation_hidden_targets");
    expect(workflow).toContain("current_moderation_review_evidence_exclusions");
    expect(workflow).toContain(
      "CREATE OR REPLACE VIEW current_unlocked_provider_main_review_scores",
    );
  });

  it("rejects malformed or underprivileged commands before SQL", async () => {
    const repository = createModerationRepository({} as Sql);
    const base = {
      actor,
      privilegedSessionId: "opaque-privileged-session",
      commandId: randomUUID(),
      reportId: randomUUID(),
      expectedState: "OPEN" as const,
      reason: "Začatie manuálneho preverenia hlásenia.",
    };
    await expect(
      repository.startReview({ ...base, reportId: "bad" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.startReview({ ...base, reason: "Kontakt admin@example.test" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.startReview({
        ...base,
        actor: { ...actor, capabilities: new Set() },
      }),
    ).rejects.toThrow("Privileged actor does not hold");
    await expect(
      repository.warn({
        ...base,
        expectedState: "UNDER_REVIEW",
        policyCategory: "HARASSMENT_ABUSE",
        policyReasonCode: "ABUSIVE_LANGUAGE",
        policyVersion: "ALPHA-1",
        subjectUserId: randomUUID(),
        enforcementScope: "CONTENT",
        userFacingReason: "Obsah porušil pravidlá komunikácie.",
        priorState: { visibility: "visible text is unsafe" },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.suspendTemporarily({
        ...base,
        commandId: randomUUID(),
        expectedState: "UNDER_REVIEW",
        policyCategory: "HARASSMENT_ABUSE",
        policyReasonCode: "TEMPORARY_PROTECTION",
        policyVersion: "ALPHA-1",
        subjectUserId: randomUUID(),
        enforcementScope: "MESSAGING",
        userFacingReason: "Správy sú dočasne obmedzené počas preverenia.",
        priorState: { messaging: "ENABLED" },
      }),
    ).rejects.toThrow("Future temporary restriction expiry is required");
  });

  it("requires complete appeal evidence and reduction scope before SQL", async () => {
    const repository = createModerationRepository({} as Sql);
    await expect(
      repository.submitAppeal({
        actorUserId: randomUUID(),
        appealId: randomUUID(),
        actionId: randomUUID(),
        explanation: "Žiadam o opätovné posúdenie rozhodnutia.",
        evidenceReferenceType: "MEDIA_ASSET",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.decideAppeal({
        actor,
        privilegedSessionId: "opaque-privileged-session",
        commandId: randomUUID(),
        appealId: randomUUID(),
        expectedState: "OPEN",
        decision: "REDUCE",
        reason: "Prehodnotenie primeranosti pôvodného opatrenia.",
        policyReasonCode: "PROPORTIONALITY_REVIEW",
        policyVersion: "ALPHA-1",
        userFacingReason: "Opatrenie bolo po preskúmaní zmiernené.",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.decideAppeal({
        actor,
        privilegedSessionId: "opaque-privileged-session",
        commandId: randomUUID(),
        appealId: randomUUID(),
        expectedState: "OPEN",
        decision: "REVERSE",
        reason: "Nové podklady vyvrátili pôvodný záver.",
        policyReasonCode: "NEW_EVIDENCE_CORRECTION",
        policyVersion: "ALPHA-1",
        reducedExpiresAt: new Date(Date.now() + 60_000),
        userFacingReason: "Pôvodné opatrenie bolo po preskúmaní zrušené.",
      }),
    ).rejects.toThrow("Only reduction may set reduced enforcement");
  });
});

function source(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
    "utf8",
  );
}
