import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createAdminDisputeRepository } from "../src/admin-dispute-repository.js";
import { createAdminJobCancellationRepository } from "../src/admin-job-cancellation-repository.js";

const enumMigration = source("0099_admin_dispute_transition_actions.sql");
const workflowMigration = source("0100_admin_dispute_workflow.sql");
const cancellationMigration = source("0101_admin_job_force_cancellation.sql");
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.disputes.manage", "admin.jobs.correct"]),
  mfaAuthenticatedAt: new Date(),
  roles: ["ADMIN"],
  userId: randomUUID() as UserId,
};

describe("R4-022 administrative dispute workflow", () => {
  it("commits enum additions before defining named case commands", () => {
    expect(enumMigration).toContain("ADD VALUE 'START_REVIEW'");
    expect(enumMigration).toContain("ADD VALUE 'REOPEN'");
    expect(workflowMigration).toContain(
      "CREATE TABLE dispute_case_admin_commands",
    );
    expect(workflowMigration).not.toMatch(/set[_ ](?:case[_ ])?status/iu);
  });

  it("requires recent MFA, exact state, immutable audit and no party-as-admin", () => {
    expect(workflowMigration).toContain("admin_dispute_session_is_recent");
    expect(workflowMigration).toContain(
      "current_state IS DISTINCT FROM NEW.expected_state",
    );
    expect(workflowMigration).toContain(
      "IF party_actor OR NOT admin_dispute_session_is_recent",
    );
    expect(workflowMigration).toContain(
      "matching immutable dispute command audit event required",
    );
    expect(workflowMigration).toContain(
      "BEFORE UPDATE OR DELETE ON dispute_case_admin_commands",
    );
  });

  it("keeps notes private and outcomes operational rather than legal/commercial", () => {
    expect(workflowMigration).toContain(
      "CREATE TABLE dispute_case_internal_notes",
    );
    expect(workflowMigration).toContain(
      "CREATE TABLE dispute_case_information_requests",
    );
    expect(workflowMigration).toContain("CREATE TABLE dispute_case_outcomes");
    expect(workflowMigration).toContain("MUTUAL_PARTY_AGREEMENT");
    expect(workflowMigration).toContain("ADMINISTRATIVE_CLOSURE");
    expect(workflowMigration).toContain(
      "never a legal verdict or commercial rewrite",
    );
  });

  it("rejects invalid command identities, unsafe audit reasons and missing capability before SQL", async () => {
    const repository = createAdminDisputeRepository({} as Sql);
    const base = {
      actor,
      privilegedSessionId: "opaque-privileged-session",
      commandId: randomUUID(),
      disputeId: randomUUID(),
      expectedState: "OPEN" as const,
      reason: "Začatie preverovania prípadu.",
    };
    await expect(
      repository.startReview({ ...base, disputeId: "bad" }),
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
      repository.requestInformation({
        ...base,
        recipient: "BOTH",
        requestText: "",
        replyDeadline: null,
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("R4-022 exceptional Job cancellation", () => {
  it("is a separate explicit command with audit, preserved prior state and user notification", () => {
    expect(cancellationMigration).toContain(
      "CREATE TABLE job_admin_cancellation_commands",
    );
    expect(cancellationMigration).toContain("admin.job.force_cancelled");
    expect(cancellationMigration).toContain(
      "coalesce(admin_cancel.user_facing_reason, cancelled.reason)",
    );
    expect(cancellationMigration).toContain("job.cancelled.admin_forced");
    expect(cancellationMigration).not.toMatch(/set[_ ]job[_ ]status/iu);
  });

  it("rejects unsafe or unbounded cancellation inputs before SQL", async () => {
    const repository = createAdminJobCancellationRepository({} as Sql);
    const base = {
      actor,
      privilegedSessionId: "opaque-privileged-session",
      commandId: randomUUID(),
      jobId: randomUUID(),
      expectedState: "IN_PROGRESS" as const,
      reason: "Zrušenie po preverení prípadu.",
      userFacingReason: "Zákazka bola administratívne ukončená.",
    };
    await expect(
      repository.forceCancel({ ...base, jobId: "bad" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.forceCancel({ ...base, reason: "Pozri https://example.test" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.forceCancel({ ...base, userFacingReason: "krátke" }),
    ).rejects.toThrow(TypeError);
  });
});

function source(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
    "utf8",
  );
}
