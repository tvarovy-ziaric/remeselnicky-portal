import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { CustomerProfileId, JobRequestId, UserId } from "@portal/domain";

import { createJobRequestLifecycleRepository } from "../src/job-request-lifecycle-repository.js";

const actor = "9a000000-0000-4000-8000-000000000001" as UserId;
const customer = "9a000000-0000-4000-8000-000000000002" as CustomerProfileId;
const request = "9a000000-0000-4000-8000-000000000003" as JobRequestId;
const commandId = "9a000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-15T08:00:00Z");

describe("job request lifecycle repository", () => {
  it("cancels an owned ACTIVE request with immutable reason provenance", async () => {
    const harness = transactionHarness([
      [],
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [row("ACTIVE", 2)],
      [],
      [],
      [row("CANCELLED", 3, "NO_LONGER_NEEDED")],
    ]);
    await expect(
      createJobRequestLifecycleRepository(harness.sql).cancelOwned({
        actorUserId: actor,
        commandId,
        expectedRevision: 2,
        jobRequestId: request,
        reason: "NO_LONGER_NEEDED",
      }),
    ).resolves.toMatchObject({
      jobRequest: {
        cancellationReason: "NO_LONGER_NEEDED",
        revision: 3,
        state: "CANCELLED",
      },
      status: "APPLIED",
    });
    expect(harness.statements.join("\n")).toContain("cancellation_reason");
    expect(harness.statements[0]).toContain("41007");
    expect(harness.statements[1]).toContain("account_state = 'ACTIVE'");
  });

  it("uses database time and refuses to extend an already expired request", async () => {
    const harness = transactionHarness([
      [],
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [row("ACTIVE", 2)],
      [{ eligible: false }],
    ]);
    await expect(
      createJobRequestLifecycleRepository(harness.sql).extendOwned({
        actorUserId: actor,
        commandId,
        expectedRevision: 2,
        jobRequestId: request,
      }),
    ).resolves.toEqual({ status: "INVALID_TRANSITION" });
    expect(harness.statements.at(-1)).toContain("clock_timestamp()");
  });

  it("duplicates current content into a new draft without copying history", async () => {
    const sourceMedia = {
      documentMediaAssetIds: ["9a000000-0000-4000-8000-000000000010"],
      photoMediaAssetIds: ["9a000000-0000-4000-8000-000000000011"],
    };
    const section = {
      payload: sourceMedia,
      sectionKey: "request.media",
      sectionSchemaVersion: 1,
    };
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [row("ACTIVE", 2)],
      [section],
      [],
      [],
      [],
      [],
      [{ revision: 1 }],
      [section],
    ]);
    const result = await createJobRequestLifecycleRepository(
      harness.sql,
    ).duplicateOwned({
      actorUserId: actor,
      commandId,
      sourceJobRequestId: request,
    });
    expect(result).toMatchObject({
      revision: 1,
      sections: [
        {
          key: "request.media",
          payload: { documentMediaAssetIds: [], photoMediaAssetIds: [] },
        },
      ],
      status: "APPLIED",
    });
    const statements = harness.statements.join("\n");
    expect(statements).toContain("INSERT INTO job_requests");
    expect(statements).toContain(
      "INSERT INTO job_request_draft_section_revisions",
    );
    expect(statements).not.toMatch(
      /INSERT INTO job_request_active_edit_commands/iu,
    );
  });

  it("expires due requests through system-only commands", async () => {
    const harness = transactionHarness([
      [{ customerProfileId: customer, id: request, revision: 2 }],
      [],
      [{}],
      [{}],
      [row("ACTIVE", 2)],
      [{ due: true }],
      [],
      [],
    ]);
    await expect(
      createJobRequestLifecycleRepository(harness.sql).expireInactive(),
    ).resolves.toEqual([request]);
    expect(harness.statements[1]).toContain("41007");
    expect(harness.statements[2]).toContain("customer_profiles");
    const command = harness.statements[6] ?? "";
    expect(command).toContain("system_initiated");
    expect(command).toContain("cancellation_reason");
  });
});

function row(
  state: "ACTIVE" | "CANCELLED",
  revision: number,
  cancellationReason: "NO_LONGER_NEEDED" | null = null,
) {
  return {
    activatedAt: now,
    cancellationReason,
    changedAt: now,
    createdAt: now,
    customerProfileId: customer,
    expiresAt: state === "ACTIVE" ? new Date("2026-10-15T08:00:00Z") : null,
    id: request,
    revision,
    state,
    warningAt: state === "ACTIVE" ? new Date("2026-10-08T08:00:00Z") : null,
  };
}

function transactionHarness(responses: readonly unknown[][]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const queue = [...responses];
  const statements: string[] = [];
  const transaction = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return Promise.resolve(queue.shift() ?? []);
    }),
    { json: (value: unknown) => value },
  ) as unknown as Sql;
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn((work: (transaction: Sql) => Promise<unknown>) =>
      work(transaction),
    ),
  }) as unknown as Sql;
  return { sql, statements };
}
