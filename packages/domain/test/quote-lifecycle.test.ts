import { describe, expect, it } from "vitest";
import {
  assertQuoteAcceptanceContext,
  assertQuoteAcceptanceContextReadInput,
  assertQuoteLifecycleCommandInput,
  assertReconfirmQuoteInput,
} from "../src/quote-lifecycle.js";

const actorUserId = "84000000-0000-4000-8000-000000000001" as never;
const quoteId = "84000000-0000-4000-8000-000000000002" as never;

describe("Quote lifecycle", () => {
  it("bounds an exact-revision private context read", () => {
    expect(() =>
      assertQuoteAcceptanceContextReadInput({
        actorUserId,
        quoteId,
        quoteRevision: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertQuoteAcceptanceContextReadInput({
        actorUserId,
        quoteId,
        quoteRevision: 0,
      }),
    ).toThrow();
  });
  it("accepts bounded explicit commands and reconfirm intent", () => {
    expect(() =>
      assertQuoteLifecycleCommandInput({
        actorUserId,
        commandId: "84000000-0000-4000-8000-000000000003",
        expectedStateRevision: 2,
        quoteId,
        quoteRevision: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertReconfirmQuoteInput({
        actorUserId,
        authoringMode: "EXTERNAL_PDF",
        commandId: "84000000-0000-4000-8000-000000000004",
        expectedSourceStateRevision: 2,
        quoteId,
        sourceQuoteRevision: 1,
        sourceState: "EXPIRED",
      }),
    ).not.toThrow();
  });
  it("enforces coherent stale/deadline acceptance facts", () => {
    expect(() => assertQuoteAcceptanceContext(context())).not.toThrow();
    expect(() =>
      assertQuoteAcceptanceContext({
        ...context(),
        lifecycleAcceptanceEligible: true,
        materiallyStale: true,
        currentRequestVisibleVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      assertQuoteAcceptanceContext({
        ...context(),
        materiallyStale: false,
        currentRequestVisibleVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      assertQuoteAcceptanceContext({
        ...context(),
        currentRequestContentRevision: 7,
      }),
    ).not.toThrow();
    expect(() =>
      assertQuoteAcceptanceContext({
        ...context(),
        authoringEligible: false,
        lifecycleAcceptanceEligible: true,
      }),
    ).toThrow();
  });
  it("rejects malformed commands", () => {
    expect(() =>
      assertQuoteLifecycleCommandInput({
        actorUserId,
        commandId: "bad",
        expectedStateRevision: 0,
        quoteId,
        quoteRevision: 1,
      }),
    ).toThrow();
    expect(() =>
      assertReconfirmQuoteInput({
        actorUserId,
        authoringMode: "EXTERNAL_PDF",
        commandId: "84000000-0000-4000-8000-000000000004",
        expectedSourceStateRevision: 2,
        quoteId,
        sourceQuoteRevision: 1,
        sourceState: "REJECTED" as never,
      }),
    ).toThrow();
  });
});

function context() {
  return {
    authoringEligible: true,
    lifecycleAcceptanceEligible: true,
    authoringMode: "PLATFORM_STRUCTURED" as const,
    currentRequestContentRevision: 2,
    currentRequestVisibleVersion: 1,
    deadlinePassed: false,
    materiallyStale: false,
    quoteId,
    quoteRevision: 1,
    requestContentRevision: 1,
    requestVisibleVersion: 1,
    state: "SUBMITTED" as const,
    stateRevision: 2,
    validUntil: null,
  };
}
