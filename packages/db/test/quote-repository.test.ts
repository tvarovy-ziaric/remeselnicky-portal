import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";

import type { QuoteId, UserId } from "@portal/domain";

import { createQuoteRepository } from "../src/quote-repository.js";

const actorUserId = "98100000-0000-4000-8000-000000000001" as UserId;
const quoteId = "98100000-0000-4000-8000-000000000002" as QuoteId;

describe("Quote repository reads", () => {
  it("locks the ACTIVE actor and owned lineage in one transaction before data", async () => {
    const fixture = scriptedSql([
      [{ id: actorUserId }],
      [context("CUSTOMER")],
      [revision("SUBMITTED")],
    ]);
    await expect(
      createQuoteRepository(fixture.sql).readOwned({ actorUserId, quoteId }),
    ).resolves.toMatchObject({
      currentDraft: null,
      currentSubmitted: { revision: 1 },
      participantRole: "CUSTOMER",
    });
    expect(fixture.beginCount).toBe(1);
    expect(fixture.statements[0]).toContain("account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain("FOR UPDATE");
    expect(fixture.statements[1]).toContain(
      "customer.owner_user_id = actor.id",
    );
    expect(fixture.statements[1]).toContain(
      "craftsman.owner_user_id = actor.id",
    );
    expect(fixture.statements[1]).toContain(
      "FOR UPDATE OF quote, customer, craftsman",
    );
    expect(fixture.statements[2]).toContain("state <> 'DRAFT'");
  });

  it("returns uniform absence before querying revisions for inactive actors", async () => {
    const fixture = scriptedSql([[]]);
    await expect(
      createQuoteRepository(fixture.sql).readOwned({ actorUserId, quoteId }),
    ).resolves.toBeNull();
    expect(fixture.statements).toHaveLength(1);
  });

  it("returns uniform absence before querying revisions for competitors", async () => {
    const fixture = scriptedSql([[{ id: actorUserId }], []]);
    await expect(
      createQuoteRepository(fixture.sql).readOwned({ actorUserId, quoteId }),
    ).resolves.toBeNull();
    expect(fixture.statements).toHaveLength(2);
  });
});

function context(participantRole: "CRAFTSMAN" | "CUSTOMER") {
  return {
    conversationId: "98100000-0000-4000-8000-000000000003",
    createdAt: new Date("2026-09-15T10:00:00Z"),
    id: quoteId,
    invitationId: "98100000-0000-4000-8000-000000000004",
    jobRequestId: "98100000-0000-4000-8000-000000000005",
    participantRole,
  };
}

function revision(state: "DRAFT" | "SUBMITTED") {
  return {
    authoringMode: "PLATFORM_STRUCTURED",
    changedAt: new Date("2026-09-15T10:01:00Z"),
    createdAt: new Date("2026-09-15T10:00:00Z"),
    rejectionReason: null,
    requestContentRevision: 1,
    requestVisibleVersion: 1,
    revision: 1,
    state,
    stateRevision: state === "DRAFT" ? 1 : 2,
    submittedAt: state === "DRAFT" ? null : new Date("2026-09-15T10:01:00Z"),
  };
}

function scriptedSql(results: unknown[][]) {
  const statements: string[] = [];
  let beginCount = 0;
  const query = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(results.shift() ?? []);
  }) as unknown as Sql;
  Object.assign(query, {
    begin: (
      optionsOrCallback: string | ((transaction: Sql) => Promise<unknown>),
      maybeCallback?: (transaction: Sql) => Promise<unknown>,
    ) => {
      beginCount += 1;
      return (
        typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : maybeCallback
      )?.(query);
    },
  });
  return {
    get beginCount() {
      return beginCount;
    },
    sql: query,
    statements,
  };
}
