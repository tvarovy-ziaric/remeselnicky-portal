import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  JobRequestIdempotencyError,
  type CustomerProfileId,
  type JobRequestId,
  type UserId,
} from "@portal/domain";

import { createJobRequestRepository } from "../src/job-request-repository.js";

const actor = "96000000-0000-4000-8000-000000000001" as UserId;
const customer = "96000000-0000-4000-8000-000000000002" as CustomerProfileId;
const request = "96000000-0000-4000-8000-000000000003" as JobRequestId;
const commandId = "96000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-15T12:00:00Z");

describe("job request repository", () => {
  it("creates one server-identified DRAFT through immutable command/revision writes", async () => {
    const harness = transactionHarness([
      [{}],
      [],
      [],
      [],
      [],
      [],
      [draftRow()],
    ]);
    const repository = createJobRequestRepository(harness.sql);

    await expect(
      repository.createDraftOwned({
        actorUserId: actor,
        commandId,
        customerProfileId: customer,
      }),
    ).resolves.toMatchObject({
      jobRequest: { revision: 1, state: "DRAFT" },
      status: "APPLIED",
    });
    expect(harness.statements[0]).toMatch(/account_state = 'ACTIVE'/u);
    expect(harness.statements[1]).toContain("pg_advisory_xact_lock");
    expect(harness.statements.join("\n")).toContain(
      "INSERT INTO job_request_commands",
    );
    expect(harness.statements.join("\n")).toContain(
      "INSERT INTO job_request_revisions",
    );
  });

  it("checks active actor before replay and rejects command collisions", async () => {
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [
        {
          actorUserId: actor,
          commandKind: "ACTIVATE",
          customerProfileId: customer,
          jobRequestId: request,
          payloadFingerprint: "0".repeat(64),
          resultingRevision: 2,
        },
      ],
    ]);
    const repository = createJobRequestRepository(harness.sql);

    await expect(
      repository.activateOwned({
        actorUserId: actor,
        commandId,
        expectedRevision: 1,
        jobRequestId: request,
      }),
    ).rejects.toBeInstanceOf(JobRequestIdempotencyError);
    expect(harness.statements[0]).toMatch(/account_state = 'ACTIVE'/u);
  });

  it("keeps activation fail-closed on server-derived missing requirements", async () => {
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [draftRow()],
      [{ missing: ["PRIMARY_PROFESSION", "DESCRIPTION", "MUNICIPALITY"] }],
    ]);
    const repository = createJobRequestRepository(harness.sql);

    await expect(
      repository.activateOwned({
        actorUserId: actor,
        commandId,
        expectedRevision: 1,
        jobRequestId: request,
      }),
    ).resolves.toEqual({
      missingRequirements: [
        "PRIMARY_PROFESSION",
        "DESCRIPTION",
        "MUNICIPALITY",
      ],
      status: "NOT_READY",
    });
    expect(harness.statements.join("\n")).not.toContain(
      "INSERT INTO job_request_commands",
    );
  });

  it("applies DRAFT to ACTIVE only after matching server readiness", async () => {
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [draftRow()],
      [{ missing: [] }],
      [],
      [],
      [activeRow()],
    ]);
    const repository = createJobRequestRepository(harness.sql);

    await expect(
      repository.activateOwned({
        actorUserId: actor,
        commandId,
        expectedRevision: 1,
        jobRequestId: request,
      }),
    ).resolves.toEqual({
      jobRequest: activeRow(),
      status: "APPLIED",
    });
    expect(harness.statements[6]).toContain("submission_eligibility_revision");
  });

  it("denies stale or foreign requests without recording a command", async () => {
    const stale = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [draftRow()],
    ]);
    await expect(
      createJobRequestRepository(stale.sql).activateOwned({
        actorUserId: actor,
        commandId,
        expectedRevision: 2,
        jobRequestId: request,
      }),
    ).resolves.toEqual({ status: "STALE_REVISION" });

    const foreign = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [],
      [],
    ]);
    await expect(
      createJobRequestRepository(foreign.sql).activateOwned({
        actorUserId: actor,
        commandId,
        expectedRevision: 1,
        jobRequestId: request,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
  });
});

function draftRow() {
  return {
    activatedAt: null,
    changedAt: now,
    createdAt: now,
    customerProfileId: customer,
    id: request,
    revision: 1,
    state: "DRAFT" as const,
  };
}

function activeRow() {
  return {
    ...draftRow(),
    activatedAt: now,
    revision: 2,
    state: "ACTIVE" as const,
  };
}

function transactionHarness(responses: readonly unknown[][]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const queue = [...responses];
  const statements: string[] = [];
  const transaction = vi.fn((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as Sql;
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn((work: (transaction: Sql) => Promise<unknown>) =>
      work(transaction),
    ),
  }) as unknown as Sql;
  return { sql, statements };
}
