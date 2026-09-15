import type { JobRequestId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createQuoteComparisonRepository } from "../src/quote-comparison-repository.js";

const actorUserId = "81000000-0000-4000-8000-000000000001" as UserId;
const jobRequestId = "81000000-0000-4000-8000-000000000002" as JobRequestId;

describe("Quote comparison repository", () => {
  it("authorizes the exact ACTIVE customer and returns an allowlisted snapshot", async () => {
    const fixture = scriptedSql([[{ id: jobRequestId }], [row()]]);
    const result = await createQuoteComparisonRepository(
      fixture.sql,
    ).readCurrent({ actorUserId, jobRequestId });
    expect(result?.items[0]).toMatchObject({
      provider: { displayName: "Majster", approvedCredentialCount: 2 },
      pdfDownloadPath: null,
    });
    expect(fixture.beginOptions).toEqual([]);
    expect(fixture.statements[0]).toContain("actor.account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain(
      "request.customer_profile_id = customer.id",
    );
    expect(fixture.statements[0]).toContain(
      "FOR UPDATE OF actor, customer, request",
    );
    expect(fixture.statements[1]).toContain("current_submitted_quotes");
    expect(fixture.statements[1]).toContain("current_quote_acceptance_context");
    expect(fixture.statements[1]).toContain(
      "lifecycle.deadline_passed IS FALSE",
    );
    expect(fixture.statements[1]).toContain(
      "external.provider_confirmed_summary_matches_pdf",
    );
    expect(fixture.statements[1]).toContain(
      "external_object.revoked_at IS NULL",
    );
    expect(fixture.statements[1]).toContain(
      "external_asset.provenance_entity_type = 'QUOTE_REVISION'",
    );
    expect(fixture.statements[1]).not.toContain(
      "current_craftsman_profile_publications",
    );
    expect(fixture.statements[1]).not.toContain("provider_owner.account_state");
    expect(JSON.stringify(result)).not.toMatch(
      /owner|storage|sha256|evidence|customerProfile/iu,
    );
  });

  it("returns uniform absence before touching quote data for another or suspended actor", async () => {
    const fixture = scriptedSql([[]]);
    await expect(
      createQuoteComparisonRepository(fixture.sql).readCurrent({
        actorUserId,
        jobRequestId,
      }),
    ).resolves.toBeNull();
    expect(fixture.statements).toHaveLength(1);
  });

  it("fails closed on malformed rows instead of leaking partial comparison", async () => {
    const fixture = scriptedSql([
      [{ id: jobRequestId }],
      [{ ...row(), providerDisplayName: null }],
    ]);
    await expect(
      createQuoteComparisonRepository(fixture.sql).readCurrent({
        actorUserId,
        jobRequestId,
      }),
    ).rejects.toThrow();
  });

  it("maps only an exact confirmed READY external PDF and rejects false confirmation", async () => {
    const external = {
      ...row(),
      authoringMode: "EXTERNAL_PDF",
      conditionalOnInspection: null,
      depositNotes: null,
      estimatedDurationDays: null,
      estimatedStartOn: null,
      excludedScope: null,
      externalDocumentReady: true,
      externalSummaryConfirmed: true,
      includedScope: null,
      inspectionConditions: null,
      laborAmountCents: null,
      laborDescription: null,
      materialAmountCents: null,
      materialDescription: null,
      materialResponsibility: null,
      otherAmountCents: null,
      otherDescription: null,
      pdfDownloadPath:
        "/v1/media/81000000-0000-4000-8000-000000000005/download",
      priceBasis: null,
      providerNotes: null,
      summary: null,
      title: null,
      travelAmountCents: null,
      travelDescription: null,
      warrantyInformation: null,
    };
    const good = scriptedSql([[{ id: jobRequestId }], [external]]);
    await expect(
      createQuoteComparisonRepository(good.sql).readCurrent({
        actorUserId,
        jobRequestId,
      }),
    ).resolves.toMatchObject({ items: [{ authoringMode: "EXTERNAL_PDF" }] });
    const bad = scriptedSql([
      [{ id: jobRequestId }],
      [{ ...external, externalSummaryConfirmed: false }],
    ]);
    await expect(
      createQuoteComparisonRepository(bad.sql).readCurrent({
        actorUserId,
        jobRequestId,
      }),
    ).rejects.toThrow(/external PDF Quote comparison binding/u);
  });

  it("keeps a materially stale submitted Quote visible as lifecycle-ineligible", async () => {
    const fixture = scriptedSql([
      [{ id: jobRequestId }],
      [{ ...row(), lifecycleAcceptanceEligible: false, materiallyStale: true }],
    ]);
    await expect(
      createQuoteComparisonRepository(fixture.sql).readCurrent({
        actorUserId,
        jobRequestId,
      }),
    ).resolves.toMatchObject({
      items: [{ lifecycleAcceptanceEligible: false, materiallyStale: true }],
    });
  });
});

function row() {
  return {
    authoringEligible: true,
    authoringMode: "PLATFORM_STRUCTURED",
    conditionalOnInspection: false,
    conversationPath:
      "/konverzacie/pozvanka/81000000-0000-4000-8000-000000000004",
    depositAmountCents: null,
    depositMode: "NONE",
    depositNotes: null,
    depositPercentageBasisPoints: null,
    estimatedDurationDays: 2,
    estimatedStartOn: "2026-10-01",
    externalDocumentReady: false,
    externalSummaryConfirmed: null,
    excludedScope: [],
    includedScope: ["Práca"],
    inspectionConditions: null,
    laborAmountCents: "8000",
    laborDescription: "Práca",
    materialAmountCents: "2000",
    materialDescription: "Materiál",
    materialResponsibility: "PROVIDER",
    lifecycleAcceptanceEligible: true,
    materiallyStale: false,
    otherAmountCents: null,
    otherDescription: null,
    pdfDownloadPath: null,
    priceBasis: "Celková cena",
    priceMode: "FIXED",
    providerNotes: null,
    providerApprovedCredentialCount: "2",
    providerDisplayName: "Majster",
    providerIdentityVerified: true,
    quoteId: "81000000-0000-4000-8000-000000000003",
    quoteRevision: 1,
    rangeMaximumCents: null,
    rangeMinimumCents: null,
    submittedAt: new Date("2026-09-15T10:00:00.000Z"),
    summary: "Montáž",
    title: "Ponuka",
    totalAmountCents: "10000",
    travelAmountCents: "0",
    travelDescription: "V cene",
    validUntil: new Date("2026-10-15T10:00:00.000Z"),
    vatStatus: "VAT_INCLUDED",
    warrantyInformation: "24 mesiacov",
  };
}

function scriptedSql(responses: unknown[][]): {
  sql: Sql;
  statements: string[];
  beginOptions: string[];
} {
  const statements: string[] = [];
  const beginOptions: string[] = [];
  let index = 0;
  const transaction = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(responses[index++] ?? []);
  }) as unknown as Sql;
  const sql = Object.assign(transaction, {
    begin: (
      optionsOrCallback: string | ((tx: Sql) => unknown),
      callback?: (tx: Sql) => unknown,
    ) => {
      if (typeof optionsOrCallback === "string") {
        beginOptions.push(optionsOrCallback);
        return callback?.(transaction);
      }
      return optionsOrCallback(transaction);
    },
  }) as unknown as Sql;
  return { sql, statements, beginOptions };
}
