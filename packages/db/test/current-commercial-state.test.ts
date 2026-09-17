import { describe, expect, it } from "vitest";

import {
  deriveCurrentCommercialState,
  type CommercialBaseQuote,
  type CommercialChangeRevision,
} from "../src/current-commercial-state.js";

const base: CommercialBaseQuote = {
  quoteId: "base-quote",
  revision: 3,
  authoringMode: "PLATFORM_STRUCTURED",
  commercialContent: {
    currency: "EUR",
    priceMode: "FIXED",
    totalAmountCents: 100_000,
    vatStatus: "VAT_INCLUDED",
    includedScope: ["Pôvodný rozsah"],
  },
};

function revision(
  id: string,
  amountCents: number,
  override: Partial<CommercialChangeRevision> = {},
): CommercialChangeRevision {
  return {
    changeOrderId: `change-${id}`,
    revisionId: `revision-${id}`,
    revisionNumber: 1,
    state: "APPROVED",
    approvedAt: new Date("2026-09-17T12:00:00.000Z"),
    terms: {
      title: "Zmena",
      reason: "Dohoda strán",
      changeDescription: "Upravený rozsah",
      scopeAdded: ["Nová práca"],
      scopeRemoved: [],
      scopeChanged: [],
      priceImpact: {
        mode: "FIXED_DELTA",
        amountCents,
        vatStatus: "VAT_INCLUDED",
      },
      scheduleImpact: { mode: "NONE" },
      externalPdfMediaAssetId: "private-internal-id",
    },
    ...override,
  };
}

describe("deriveCurrentCommercialState", () => {
  it("adds and subtracts only approved fixed deltas, preserving chronological provenance", () => {
    const later = revision("later", -5_000, {
      approvedAt: new Date("2026-09-17T13:00:00.000Z"),
    });
    const earlier = revision("earlier", 20_000);
    const draft = revision("draft", 900_000, { state: "DRAFT" });
    const projection = deriveCurrentCommercialState(base, [
      later,
      draft,
      earlier,
    ]);

    expect(projection.originalTotalCents).toBe(100_000);
    expect(projection.fixedDeltaCents).toBe(15_000);
    expect(projection.exactTotalCents).toBe(115_000);
    expect(projection.exactTotalUnavailableReason).toBeNull();
    expect(projection.base).toMatchObject({
      source: "BASE_QUOTE",
      quoteId: "base-quote",
      revision: 3,
    });
    expect(projection.approvedChanges.map((item) => item.revisionId)).toEqual([
      "revision-earlier",
      "revision-later",
    ]);
    expect(projection.approvedChanges[0]?.approvedAt).toBe(
      "2026-09-17T12:00:00.000Z",
    );
    expect(JSON.stringify(projection)).not.toContain("private-internal-id");
    expect(base.commercialContent["totalAmountCents"]).toBe(100_000);
  });

  it("does not make an estimate exact even with a fixed delta", () => {
    const result = deriveCurrentCommercialState(
      {
        ...base,
        commercialContent: { ...base.commercialContent, priceMode: "ESTIMATE" },
      },
      [revision("one", 500)],
    );
    expect(result.exactTotalCents).toBeNull();
    expect(result.exactTotalUnavailableReason).toBe("BASE_NOT_FIXED");
    expect(result.approvedChanges).toHaveLength(1);
  });

  it("retains uncertainty from a range delta and VAT incompatibility", () => {
    const ranged = revision("range", 500, {
      terms: {
        ...revision("unused", 500).terms,
        priceImpact: {
          mode: "RANGE_DELTA",
          minimumCents: 100,
          maximumCents: 900,
          basis: "Podľa rozsahu",
          vatStatus: "VAT_INCLUDED",
        },
      },
    });
    expect(
      deriveCurrentCommercialState(base, [ranged]).exactTotalUnavailableReason,
    ).toBe("NON_FIXED_DELTA");

    const mixedVat = revision("vat", 500, {
      terms: {
        ...revision("unused", 500).terms,
        priceImpact: {
          mode: "FIXED_DELTA",
          amountCents: 500,
          vatStatus: "VAT_EXCLUDED",
        },
      },
    });
    expect(
      deriveCurrentCommercialState(base, [mixedVat])
        .exactTotalUnavailableReason,
    ).toBe("VAT_MISMATCH");
  });

  it("deduplicates an exact revision without double-applying its price", () => {
    const approved = revision("one", 500);
    const result = deriveCurrentCommercialState(base, [approved, approved]);
    expect(result.approvedChanges).toHaveLength(1);
    expect(result.exactTotalCents).toBe(100_500);
  });

  it("refuses precision for conflicting approvals or unsafe/negative totals", () => {
    const first = revision("one", 500);
    const conflicting = revision("two", 200, {
      changeOrderId: first.changeOrderId,
      revisionNumber: 2,
    });
    expect(
      deriveCurrentCommercialState(base, [first, conflicting])
        .exactTotalUnavailableReason,
    ).toBe("CONFLICTING_APPROVALS");
    expect(
      deriveCurrentCommercialState(base, [revision("negative", -100_001)])
        .exactTotalUnavailableReason,
    ).toBe("UNSAFE_AMOUNT");
  });

  it("keeps no-price schedule/scope changes as provenance without altering total", () => {
    const schedule = revision("schedule", 100, {
      terms: {
        ...revision("unused", 100).terms,
        priceImpact: { mode: "NONE" },
        scheduleImpact: { mode: "DAYS", deltaDays: 3 },
      },
    });
    const result = deriveCurrentCommercialState(base, [schedule]);
    expect(result.exactTotalCents).toBe(100_000);
    expect(result.approvedChanges[0]?.terms.scheduleImpact).toEqual({
      mode: "DAYS",
      deltaDays: 3,
    });
  });
});
