import { describe, expect, it } from "vitest";

import {
  assertQuoteAcceptanceCommandInput,
  type QuoteAcceptanceCommandInput,
} from "../src/quote-acceptance.js";

const valid = Object.freeze({
  actorUserId: "89000000-0000-4000-8000-000000000001" as never,
  commandId: "89000000-0000-4000-8000-000000000002",
  explicitlyConfirmed: true,
  expectedQuoteStateRevision: 2,
  expectedRequestContentRevision: 3,
  expectedRequestVisibleVersion: 1,
  jobRequestId: "89000000-0000-4000-8000-000000000003" as never,
  quoteId: "89000000-0000-4000-8000-000000000004" as never,
  quoteRevision: 1,
} satisfies QuoteAcceptanceCommandInput);

describe("Quote acceptance command boundary", () => {
  it("requires one explicit confirmation against exact positive revisions", () => {
    expect(() => assertQuoteAcceptanceCommandInput(valid)).not.toThrow();
    expect(() =>
      assertQuoteAcceptanceCommandInput({
        ...valid,
        explicitlyConfirmed: false,
      } as never),
    ).toThrow();
    expect(() =>
      assertQuoteAcceptanceCommandInput({
        ...valid,
        expectedQuoteStateRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      assertQuoteAcceptanceCommandInput({
        ...valid,
        expectedRequestContentRevision: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });

  it("rejects unknown client-authored authority fields", () => {
    expect(() =>
      assertQuoteAcceptanceCommandInput({
        ...valid,
        acceptedAt: "2026-09-16T12:00:00.000Z",
      } as never),
    ).toThrow();
    expect(() =>
      assertQuoteAcceptanceCommandInput({
        ...valid,
        jobRequestId: "not-a-uuid",
      } as never),
    ).toThrow();
  });

  it("allows one bounded exact-address clarification without accepting a municipality change", () => {
    expect(() =>
      assertQuoteAcceptanceCommandInput({
        ...valid,
        finalExactAddress: "Hlavná 12",
      }),
    ).not.toThrow();
    for (const finalExactAddress of ["", " Hlavná 12", "x".repeat(501)])
      expect(() =>
        assertQuoteAcceptanceCommandInput({ ...valid, finalExactAddress }),
      ).toThrow();
    expect(() =>
      assertQuoteAcceptanceCommandInput({
        ...valid,
        municipalityCode: "SK01001",
      } as never),
    ).toThrow();
  });
});
