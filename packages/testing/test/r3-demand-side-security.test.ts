import { describe, expect, it } from "vitest";

import {
  R3_DATABASE_SECURITY_CASES,
  R3_DATABASE_SECURITY_SURFACES,
  R3_SECURITY_ACTORS,
  R3_SECURITY_STATES,
  R3_SECURITY_TARGETS,
  R3_STAGE_ONE_MISSING_SEAMS,
  verifyR3DatabaseSecurityMatrix,
  type R3DatabaseBoundaryProbeResult,
  type R3DatabaseSecurityCase,
  type R3DatabaseSecurityMatrixAdapter,
} from "../src/r3-demand-side-security.js";

describe("R3 demand-side security matrix", () => {
  it("covers actor, target-lineage and state without claiming HTTP/UI", async () => {
    const report = await verifyR3DatabaseSecurityMatrix(validAdapter());
    const denied = R3_DATABASE_SECURITY_CASES.filter(
      ({ expectedAllowed }) => !expectedAllowed,
    );
    const positive = R3_DATABASE_SECURITY_CASES.length - denied.length;
    expect(report).toEqual({
      browser: {
        missingSeams: R3_STAGE_ONE_MISSING_SEAMS,
        status: "NOT_EVALUATED",
      },
      database: {
        declaredProbes: R3_DATABASE_SECURITY_CASES.length,
        deniedCommandNoEffectChecks: denied.filter(
          ({ action }) => action === "COMMAND",
        ).length,
        deniedProbes: denied.length,
        evaluatedProbes: R3_DATABASE_SECURITY_CASES.length,
        notEvaluatedCaseIds: [],
        positiveProbes: positive,
        status: "VERIFIED",
      },
      http: {
        missingSeams: R3_STAGE_ONE_MISSING_SEAMS,
        status: "NOT_EVALUATED",
      },
    });
    expect(new Set(R3_DATABASE_SECURITY_CASES.map(({ id }) => id)).size).toBe(
      R3_DATABASE_SECURITY_CASES.length,
    );
    expect(
      new Set(R3_DATABASE_SECURITY_CASES.map(({ target }) => target)),
    ).toEqual(new Set(R3_SECURITY_TARGETS));
    expect(
      new Set(R3_DATABASE_SECURITY_CASES.map(({ actor }) => actor)),
    ).toEqual(new Set(R3_SECURITY_ACTORS));
    expect(
      new Set(R3_DATABASE_SECURITY_CASES.map(({ surface }) => surface)),
    ).toEqual(new Set(R3_DATABASE_SECURITY_SURFACES));
    expect(
      new Set(R3_DATABASE_SECURITY_CASES.map(({ state }) => state)),
    ).toEqual(new Set(R3_SECURITY_STATES));
  });

  it("derives decisions from target lineage and state, not actor alone", async () => {
    await expect(
      verifyR3DatabaseSecurityMatrix(actorOnlyAdapter()),
    ).rejects.toThrow(/decision mismatch/u);
    await expect(
      verifyR3DatabaseSecurityMatrix(stateBlindAdapter()),
    ).rejects.toThrow(/decision mismatch/u);

    expect(
      findCase(
        "QUOTE_STRUCTURED_REVISION",
        "PROVIDER_DRAFT",
        "EXACT_OWN",
        "CUSTOMER_OWNER",
      ).expectedAllowed,
    ).toBe(false);
    expect(
      findCase(
        "CONVERSATION_WRITE",
        "TERMINAL_LINEAGE",
        "EXACT_OWN",
        "PROVIDER_OWNER",
      ).expectedOutcome,
    ).toBe("READ_ONLY");
    expect(
      findCase(
        "QUOTE_CORE",
        "SUBMITTED_OR_HISTORICAL",
        "EXACT_OWN",
        "CUSTOMER_OWNER",
      ).expectedAllowed,
    ).toBe(true);
    expect(
      findCase(
        "CONVERSATION_WRITE",
        "TERMINAL_LINEAGE",
        "EXACT_OWN",
        "PROVIDER_OWNER",
      ).expectedAllowed,
    ).toBe(false);
    expect(
      findCase("CONVERSATION_WRITE", "WRITABLE", "EXACT_OWN", "PROVIDER_OWNER")
        .expectedAllowed,
    ).toBe(true);
  });

  it("rejects a false allow, a false deny and an imprecise positive outcome", async () => {
    for (const mutate of [
      (
        testCase: R3DatabaseSecurityCase,
        result: R3DatabaseBoundaryProbeResult,
      ) => (testCase.expectedAllowed ? { ...result, allowed: false } : result),
      (
        testCase: R3DatabaseSecurityCase,
        result: R3DatabaseBoundaryProbeResult,
      ) => (testCase.expectedAllowed ? result : { ...result, allowed: true }),
      (
        testCase: R3DatabaseSecurityCase,
        result: R3DatabaseBoundaryProbeResult,
      ) =>
        testCase.expectedAllowed
          ? { ...result, outcome: "NOT_FOUND" as const }
          : result,
    ]) {
      await expect(
        verifyR3DatabaseSecurityMatrix(validAdapter(mutate)),
      ).rejects.toThrow(/decision mismatch/u);
    }
  });

  it("reports intentionally unsupported database cases as partial evidence", async () => {
    const unsupportedId = R3_DATABASE_SECURITY_CASES[0]?.id;
    if (unsupportedId === undefined) throw new Error("Missing matrix case.");
    const report = await verifyR3DatabaseSecurityMatrix({
      ...validAdapter(),
      probe(testCase) {
        if (testCase.id === unsupportedId) {
          return Promise.resolve({
            evaluation: "NOT_EVALUATED" as const,
            reason: "No terminal fixture in this isolated adapter.",
          });
        }
        return Promise.resolve(expectedResult(testCase));
      },
    });
    expect(report.database.status).toBe("PARTIALLY_VERIFIED");
    expect(report.database.evaluatedProbes).toBe(
      R3_DATABASE_SECURITY_CASES.length - 1,
    );
    expect(report.database.notEvaluatedCaseIds).toEqual([unsupportedId]);
  });

  it("requires an explicit reason for missing database evidence", async () => {
    await expect(
      verifyR3DatabaseSecurityMatrix({
        ...validAdapter(),
        probe: () =>
          Promise.resolve({
            evaluation: "NOT_EVALUATED" as const,
            reason: "  ",
          }),
      }),
    ).rejects.toThrow(/Missing NOT_EVALUATED reason/u);
  });

  it("rejects private and competitor markers in denied payloads", async () => {
    await expect(
      verifyR3DatabaseSecurityMatrix(
        validAdapter((testCase, result) =>
          testCase.expectedAllowed
            ? result
            : { ...result, payload: { message: privateMarker } },
        ),
      ),
    ).rejects.toThrow(/private marker/u);
    await expect(
      verifyR3DatabaseSecurityMatrix(
        validAdapter((testCase, result) =>
          testCase.expectedAllowed
            ? result
            : { ...result, payload: { value: competitorMarker } },
        ),
      ),
    ).rejects.toThrow(/private marker/u);
  });

  it("rejects cross-provider leakage on either same-request lineage", async () => {
    await expect(
      verifyR3DatabaseSecurityMatrix(
        validAdapter((testCase, result) =>
          testCase.expectedAllowed &&
          testCase.actor === "PROVIDER_OWNER" &&
          testCase.target === "EXACT_OWN"
            ? { ...result, payload: { displayName: competitorMarker } }
            : result,
        ),
      ),
    ).rejects.toThrow(/competitor/u);
    await expect(
      verifyR3DatabaseSecurityMatrix(
        validAdapter((testCase, result) =>
          testCase.expectedAllowed &&
          testCase.actor === "COMPETING_PROVIDER" &&
          testCase.target === "COMPETITOR_SAME_REQUEST"
            ? { ...result, payload: { displayName: privateMarker } }
            : result,
        ),
      ),
    ).rejects.toThrow(/foreign/u);
  });

  it("requires no-effect evidence for every denied command", async () => {
    await expect(
      verifyR3DatabaseSecurityMatrix(
        validAdapter((testCase, result) =>
          !testCase.expectedAllowed && testCase.action === "COMMAND"
            ? { ...result, effectCountAfter: 1 }
            : result,
        ),
      ),
    ).rejects.toThrow(/effect evidence/u);
  });

  it("rejects sensitive implementation keys even in positive payloads", async () => {
    await expect(
      verifyR3DatabaseSecurityMatrix(
        validAdapter((testCase, result) =>
          testCase.expectedAllowed
            ? { ...result, payload: { storageKey: "private/object" } }
            : result,
        ),
      ),
    ).rejects.toThrow(/forbidden private field/u);
  });

  it("rejects empty or unsafe synthetic marker sets", async () => {
    await expect(
      verifyR3DatabaseSecurityMatrix({
        ...validAdapter(),
        privateMarkers: [],
      }),
    ).rejects.toThrow(/markers/u);
    await expect(
      verifyR3DatabaseSecurityMatrix({
        ...validAdapter(),
        competitorMarkers: ["unsafe\nmarker"],
      }),
    ).rejects.toThrow(/markers/u);
  });
});

const privateMarker = "TARGET_PRIVATE_CANARY_022";
const competitorMarker = "COMPETITOR_PRIVATE_CANARY_022";

function validAdapter(
  mutate: (
    testCase: R3DatabaseSecurityCase,
    result: R3DatabaseBoundaryProbeResult,
  ) => R3DatabaseBoundaryProbeResult = (_testCase, result) => result,
): R3DatabaseSecurityMatrixAdapter {
  return {
    competitorMarkers: [competitorMarker],
    privateMarkers: [privateMarker],
    probe(testCase) {
      return Promise.resolve(mutate(testCase, expectedResult(testCase)));
    },
  };
}

function expectedResult(
  testCase: R3DatabaseSecurityCase,
): R3DatabaseBoundaryProbeResult {
  return testCase.expectedAllowed
    ? {
        evaluation: "EVALUATED",
        allowed: true,
        outcome: testCase.expectedOutcome,
        payload: {},
      }
    : {
        evaluation: "EVALUATED",
        allowed: false,
        ...(testCase.action === "COMMAND"
          ? { effectCountAfter: 0, effectCountBefore: 0 }
          : {}),
        outcome: testCase.expectedOutcome,
        payload: { code: "NOT_FOUND" },
      };
}

function actorOnlyAdapter(): R3DatabaseSecurityMatrixAdapter {
  return {
    competitorMarkers: [competitorMarker],
    privateMarkers: [privateMarker],
    probe(testCase) {
      const allowed =
        testCase.actor === "CUSTOMER_OWNER" ||
        testCase.actor === "PROVIDER_OWNER";
      return Promise.resolve({
        evaluation: "EVALUATED" as const,
        allowed,
        ...(testCase.action === "COMMAND"
          ? { effectCountAfter: 0, effectCountBefore: 0 }
          : {}),
        outcome: allowed ? allowedOutcome(testCase) : ("NOT_FOUND" as const),
        payload: {},
      });
    },
  };
}

function stateBlindAdapter(): R3DatabaseSecurityMatrixAdapter {
  return {
    competitorMarkers: [competitorMarker],
    privateMarkers: [privateMarker],
    probe(testCase) {
      const roleAllowed =
        testCase.target === "EXACT_OWN" &&
        (testCase.actor === "CUSTOMER_OWNER" ||
          testCase.actor === "PROVIDER_OWNER");
      return Promise.resolve({
        evaluation: "EVALUATED" as const,
        allowed: roleAllowed,
        ...(testCase.action === "COMMAND"
          ? { effectCountAfter: 0, effectCountBefore: 0 }
          : {}),
        outcome: roleAllowed
          ? allowedOutcome(testCase)
          : ("NOT_FOUND" as const),
        payload: {},
      });
    },
  };
}

function allowedOutcome(
  testCase: R3DatabaseSecurityCase,
): "APPLIED" | "FOUND" | "GRANTED" {
  if (testCase.action === "COMMAND") return "APPLIED";
  if (testCase.action === "DOWNLOAD") return "GRANTED";
  return "FOUND";
}

function findCase(
  surface: R3DatabaseSecurityCase["surface"],
  state: R3DatabaseSecurityCase["state"],
  target: R3DatabaseSecurityCase["target"],
  actor: R3DatabaseSecurityCase["actor"],
): R3DatabaseSecurityCase {
  const result = R3_DATABASE_SECURITY_CASES.find(
    (testCase) =>
      testCase.surface === surface &&
      testCase.state === state &&
      testCase.target === target &&
      testCase.actor === actor,
  );
  if (result === undefined) throw new Error("Missing expected R3 matrix case.");
  return result;
}
