import { createHash } from "node:crypto";

import {
  normalizeSaveStructuredQuoteDraftInput,
  type QuoteId,
  type UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createStructuredQuoteRepository } from "../src/quote-structured-repository.js";

const actorUserId = "98300000-0000-4000-8000-000000000001" as UserId;
const quoteId = "98300000-0000-4000-8000-000000000002" as QuoteId;
const commandId = "98300000-0000-4000-8000-000000000003";

describe("structured Quote repository", () => {
  it("locks ACTIVE owner and Quote before reading private content", async () => {
    const fixture = scriptedSql([
      [{ id: actorUserId }],
      [{ id: quoteId }],
      [contentRow()],
    ]);
    await expect(
      createStructuredQuoteRepository(fixture.sql).readOwned({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toMatchObject({
      contentRevision: 1,
      priceMode: "FIXED",
      totalAmountCents: 150_000,
    });
    expect(fixture.beginCount).toBe(1);
    expect(fixture.statements[0]).toContain("account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain("FOR UPDATE");
    expect(fixture.statements[1]).toContain("head.state <> 'DRAFT'");
    expect(fixture.statements[1]).toContain(
      "FOR UPDATE OF quote, customer, craftsman",
    );
  });

  it("does not query content for inactive actors or competitors", async () => {
    const inactive = scriptedSql([[]]);
    await expect(
      createStructuredQuoteRepository(inactive.sql).readOwned({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toBeNull();
    expect(inactive.statements).toHaveLength(1);

    const competitor = scriptedSql([[{ id: actorUserId }], []]);
    await expect(
      createStructuredQuoteRepository(competitor.sql).readOwned({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toBeNull();
    expect(competitor.statements).toHaveLength(2);
  });

  it("fails closed when a persisted projection violates domain invariants", async () => {
    const invalidAmount = scriptedSql([
      [{ id: actorUserId }],
      [{ id: quoteId }],
      [{ ...contentRow(), totalAmountCents: "0" }],
    ]);
    await expect(
      createStructuredQuoteRepository(invalidAmount.sql).readOwned({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).rejects.toThrow(/totalAmountCents/u);

    const invalidText = scriptedSql([
      [{ id: actorUserId }],
      [{ id: quoteId }],
      [{ ...contentRow(), title: "Kontakt +421 900 123 456" }],
    ]);
    await expect(
      createStructuredQuoteRepository(invalidText.sql).readOwned({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).rejects.toThrow(/title/u);
  });

  it("reauthorizes and locks lineage before replay, without reapplying CAS", async () => {
    const input = saveInput();
    const fixture = scriptedSql([
      [],
      [{ id: actorUserId }],
      [
        {
          conversationId: "98300000-0000-4000-8000-000000000004",
          invitationId: "98300000-0000-4000-8000-000000000005",
        },
      ],
      [{ id: "98300000-0000-4000-8000-000000000005" }],
      [{ id: "98300000-0000-4000-8000-000000000004" }],
      [{ id: quoteId }],
      [
        {
          actorUserId,
          payloadFingerprint: fingerprint(input),
          quoteId,
          quoteRevision: 1,
          resultingContentRevision: 1,
        },
      ],
      [contentRow()],
    ]);
    await expect(
      createStructuredQuoteRepository(fixture.sql).saveDraft(input),
    ).resolves.toMatchObject({ status: "DEDUPLICATED" });
    const joined = fixture.statements.join("\n");
    expect(joined.indexOf("account_state = 'ACTIVE'")).toBeLessThan(
      joined.indexOf("FROM quote_structured_authoring_commands"),
    );
    expect(joined.indexOf("FROM quotes quote")).toBeLessThan(
      joined.indexOf("FROM quote_structured_authoring_commands"),
    );
    expect(joined).not.toContain(
      "current_quote_structured_content content\n  WHERE",
    );
  });

  it("maps a submit-won database race to READ_ONLY", async () => {
    const fixture = scriptedSql([
      [],
      [{ id: actorUserId }],
      [
        {
          conversationId: "98300000-0000-4000-8000-000000000004",
          invitationId: "98300000-0000-4000-8000-000000000005",
        },
      ],
      [{ id: "98300000-0000-4000-8000-000000000005" }],
      [{ id: "98300000-0000-4000-8000-000000000004" }],
      [{ id: quoteId }],
      [],
      new Error("editable PLATFORM_STRUCTURED Quote draft required"),
    ]);

    await expect(
      createStructuredQuoteRepository(fixture.sql).saveDraft(saveInput()),
    ).resolves.toEqual({ status: "READ_ONLY" });
  });
});

function saveInput() {
  return {
    actorUserId,
    commandId,
    content: {
      components: {
        transport: {
          amountCents: 5_000,
          description: "Paušálna doprava",
        },
      },
      conditionalOnInspection: false,
      currency: "EUR" as const,
      materialResponsibility: "PROVIDER" as const,
      priceBasis: "Celková cena za uvedený rozsah",
      priceMode: "FIXED" as const,
      summary: "Montáž podľa zadania",
      title: "Montáž",
      totalAmountCents: 150_000,
      vatStatus: "VAT_INCLUDED" as const,
    },
    expectedContentRevision: 0,
    quoteId,
    quoteRevision: 1,
  };
}

function fingerprint(input: ReturnType<typeof saveInput>): string {
  const normalized = normalizeSaveStructuredQuoteDraftInput(input);
  return createHash("sha256")
    .update(JSON.stringify({ ...normalized, commandId: undefined }))
    .digest("hex");
}

function contentRow() {
  return {
    changedAt: new Date("2026-09-15T11:00:00Z"),
    conditionalOnInspection: false,
    contentRevision: 1,
    currency: "EUR",
    depositAmountCents: null,
    depositMode: null,
    depositNotes: null,
    depositPercentageBasisPoints: null,
    estimatedDurationDays: 3,
    estimatedStartOn: "2026-10-05",
    excludedScope: [],
    includedScope: ["Montáž"],
    inspectionConditions: null,
    laborAmountCents: "100000",
    laborDescription: "Práca",
    materialAmountCents: "45000",
    materialDescription: "Materiál",
    materialResponsibility: "PROVIDER",
    otherAmountCents: null,
    otherDescription: null,
    priceBasis: "Celková cena za uvedený rozsah",
    priceMode: "FIXED",
    providerNotes: null,
    quoteId,
    quoteRevision: 1,
    rangeMaximumCents: null,
    rangeMinimumCents: null,
    summary: "Montáž podľa zadania",
    title: "Montáž",
    totalAmountCents: "150000",
    transportAmountCents: "5000",
    transportDescription: "Paušálna doprava",
    validUntil: new Date("2026-10-01T21:59:59Z"),
    vatStatus: "VAT_INCLUDED",
    warrantyInformation: "24 mesiacov",
  };
}

function scriptedSql(results: Array<unknown[] | Error>) {
  const statements: string[] = [];
  let beginCount = 0;
  const query = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    const result = results.shift() ?? [];
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
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
