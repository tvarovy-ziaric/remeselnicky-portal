import { randomUUID } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createAdminJobCompletionRepository } from "../src/admin-job-completion-repository.js";

const repository = createAdminJobCompletionRepository({} as Sql);
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.jobs.correct"]),
  mfaAuthenticatedAt: new Date(),
  roles: ["ADMIN"],
  userId: randomUUID() as UserId,
};
const command = () => ({
  actor,
  privilegedSessionId: "opaque-privileged-session",
  commandId: randomUUID(),
  jobId: randomUUID(),
  expectedState: "IN_PROGRESS" as const,
  reason: "Dokončenie po preverení skutkového stavu.",
});

describe("administrative completion input boundary", () => {
  it("rejects invalid state, reason and identity before database access", async () => {
    await expect(
      repository.forceComplete({ ...command(), jobId: "bad" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.forceComplete({
        ...command(),
        expectedState: "COMPLETED" as never,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.forceComplete({ ...command(), reason: "Too short" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.forceComplete({
        ...command(),
        reason: "Contact admin@example.test for approval",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("cannot construct the correction audit actor without the capability", async () => {
    await expect(
      repository.forceComplete({
        ...command(),
        actor: { ...actor, capabilities: new Set() },
      }),
    ).rejects.toThrow("Privileged actor does not hold");
  });
});
