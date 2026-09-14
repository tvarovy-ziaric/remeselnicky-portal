import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import type {
  CraftsmanProfileId,
  CustomerProfileId,
  UserId,
} from "@portal/domain";

import { createCustomerShortlistRepository } from "../src/customer-shortlist-repository.js";

const actor = "92000000-0000-4000-8000-000000000001" as UserId;
const customer = "92000000-0000-4000-8000-000000000002" as CustomerProfileId;
const target = "92000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const targetOwner = "92000000-0000-4000-8000-000000000004";
const commandId = "92000000-0000-4000-8000-000000000005";

describe("customer shortlist repository", () => {
  it("locks target then actors, checks live public eligibility, and applies ADD", async () => {
    const changedAt = new Date("2026-09-15T08:00:00Z");
    const harness = transactionHarness([
      [{ ownerUserId: targetOwner }],
      [{}],
      [{}, {}],
      [{}],
      [],
      [{}],
      [],
      [],
      [{ changedAt }],
      [],
      [{ count: 1 }],
    ]);
    const repository = createCustomerShortlistRepository(harness.sql);

    await expect(
      repository.addOwned({
        actorUserId: actor,
        commandId,
        craftsmanProfileId: target,
        customerProfileId: customer,
      }),
    ).resolves.toEqual({
      activeShortlistSize: 1,
      revision: 1,
      state: "ACTIVE",
      status: "APPLIED",
    });
    expect(harness.statements[1]).toMatch(
      /craftsman_profiles[\s\S]*FOR UPDATE/u,
    );
    expect(harness.statements[2]).toMatch(/ORDER BY id[\s\S]*FOR UPDATE/u);
    expect(harness.statements[5]).toContain(
      "current_searchable_craftsman_profiles",
    );
    expect(harness.statements.join("\n")).toContain(
      "customer_shortlist_effects",
    );
  });

  it("denies hidden targets without writing a command", async () => {
    const harness = transactionHarness([
      [{ ownerUserId: targetOwner }],
      [{}],
      [{}, {}],
      [{}],
      [],
      [],
    ]);
    const repository = createCustomerShortlistRepository(harness.sql);

    await expect(
      repository.addOwned({
        actorUserId: actor,
        commandId,
        craftsmanProfileId: target,
        customerProfileId: customer,
      }),
    ).resolves.toEqual({ status: "TARGET_NOT_AVAILABLE" });
    expect(harness.statements.join("\n")).not.toContain(
      "INSERT INTO customer_shortlist_commands",
    );
  });

  it("allows REMOVE without querying target publication", async () => {
    const harness = transactionHarness([
      [{ ownerUserId: targetOwner }],
      [{}],
      [{}, {}],
      [{}],
      [],
      [{ revision: 1, state: "ACTIVE" }],
      [],
      [{ changedAt: new Date() }],
      [],
      [{ count: 0 }],
    ]);
    const repository = createCustomerShortlistRepository(harness.sql);

    await expect(
      repository.removeOwned({
        actorUserId: actor,
        commandId,
        craftsmanProfileId: target,
        customerProfileId: customer,
      }),
    ).resolves.toMatchObject({
      activeShortlistSize: 0,
      state: "REMOVED",
      status: "APPLIED",
    });
    expect(harness.statements.join("\n")).not.toContain(
      "current_searchable_craftsman_profiles",
    );
  });
});

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
