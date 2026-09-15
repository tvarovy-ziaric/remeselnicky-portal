import { createHash } from "node:crypto";

import type { QuoteId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createQuoteLifecycleRepository } from "../src/quote-lifecycle-repository.js";

const actorUserId = "85100000-0000-4000-8000-000000000001" as UserId;
const quoteId = "85100000-0000-4000-8000-000000000002" as QuoteId;
const commandId = "85100000-0000-4000-8000-000000000003";

describe("Quote lifecycle repository", () => {
  it("claims a bounded ordered due batch with SKIP LOCKED", async () => {
    const fixture = scriptedSql([[]]);
    await expect(
      createQuoteLifecycleRepository(fixture.sql).expireDueSubmitted(),
    ).resolves.toEqual([]);
    expect(fixture.statements[0]).toContain("current_submitted_quotes");
    expect(fixture.statements[0]).toContain("clock_timestamp()");
    expect(fixture.statements[0]).toContain(
      "FOR UPDATE OF invitation SKIP LOCKED",
    );
    expect(fixture.statements[0]).toContain("LIMIT");
  });

  it("reauthorizes ACTIVE+writable provider before returning an idempotent replay", async () => {
    const input = {
      actorUserId,
      commandId,
      expectedStateRevision: 2,
      quoteId,
      quoteRevision: 1,
    };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({ kind: "WITHDRAW", ...input, commandId: undefined }),
      )
      .digest("hex");
    const fixture = scriptedSql([
      [{}],
      [{ id: actorUserId }],
      [
        {
          conversationId: "85100000-0000-4000-8000-000000000004",
          invitationId: "85100000-0000-4000-8000-000000000005",
        },
      ],
      [{}],
      [{}],
      [{}],
      [{ allowed: true }],
      [
        {
          actorUserId,
          commandKind: "WITHDRAW",
          expectedStateRevision: 2,
          payloadFingerprint: fingerprint,
          quoteId,
          quoteRevision: 1,
        },
      ],
      [context("WITHDRAWN", false)],
    ]);
    await expect(
      createQuoteLifecycleRepository(fixture.sql).withdraw(input),
    ).resolves.toMatchObject({ status: "DEDUPLICATED" });
    expect(fixture.statements[1]).toContain("account_state = 'ACTIVE'");
    expect(fixture.statements[3]).toContain("job_invitations");
    expect(fixture.statements[4]).toContain("conversations");
    expect(fixture.statements[5]).toContain("FROM quotes");
    expect(fixture.statements[6]).toContain("'CRAFTSMAN', true");
    expect(fixture.statements[7]).toContain("quote_lifecycle_commands");
  });

  it("denies a suspended provider before probing private Quote identity", async () => {
    const fixture = scriptedSql([[{}], []]);
    await expect(
      createQuoteLifecycleRepository(fixture.sql).withdraw({
        actorUserId,
        commandId,
        expectedStateRevision: 2,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    expect(fixture.statements).toHaveLength(2);
  });

  it("CAS-checks exact source revision/state after canonical reconfirm locks", async () => {
    const fixture = scriptedSql([
      [{ id: actorUserId }],
      [
        {
          conversationId: "85100000-0000-4000-8000-000000000004",
          invitationId: "85100000-0000-4000-8000-000000000005",
          jobRequestId: "85100000-0000-4000-8000-000000000006",
        },
      ],
      [{}],
      [{}],
      [{}],
      [{}],
      [{ allowed: true }],
      [],
      [],
    ]);
    await expect(
      createQuoteLifecycleRepository(fixture.sql).reconfirm({
        actorUserId,
        authoringMode: "PLATFORM_STRUCTURED",
        commandId,
        expectedSourceStateRevision: 3,
        quoteId,
        sourceQuoteRevision: 2,
        sourceState: "EXPIRED",
      }),
    ).resolves.toEqual({ status: "STALE_REVISION" });
    expect(fixture.statements[2]).toContain("job_invitations");
    expect(fixture.statements[3]).toContain("conversations");
    expect(fixture.statements[4]).toContain("job_requests");
    expect(fixture.statements[5]).toContain("FROM quotes");
    expect(fixture.statements[6]).toContain("quote_active_participant_context");
    expect(fixture.statements[7]).toContain("quote_core_commands");
    expect(fixture.statements[8]).toContain("head.quote_revision =");
    expect(fixture.statements[8]).toContain("max(revision)");
    expect(fixture.statements[8]).toContain("current_quote_drafts");
  });
});

function context(
  state: "SUBMITTED" | "WITHDRAWN",
  lifecycleAcceptanceEligible: boolean,
) {
  return {
    authoringEligible: true,
    authoringMode: "PLATFORM_STRUCTURED",
    currentRequestContentRevision: 2,
    currentRequestVisibleVersion: 1,
    deadlinePassed: false,
    lifecycleAcceptanceEligible,
    materiallyStale: false,
    quoteId,
    quoteRevision: 1,
    requestContentRevision: 1,
    requestVisibleVersion: 1,
    state,
    stateRevision: 3,
    validUntil: null,
  };
}

function scriptedSql(results: unknown[][]) {
  const statements: string[] = [];
  const query = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(results.shift() ?? []);
  }) as unknown as Sql;
  Object.assign(query, {
    begin: (callback: (transaction: Sql) => Promise<unknown>) =>
      callback(query),
    savepoint: (callback: (transaction: Sql) => Promise<unknown>) =>
      callback(query),
  });
  return { sql: query, statements };
}
