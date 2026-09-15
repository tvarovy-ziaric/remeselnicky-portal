import { describe, expect, it } from "vitest";

import {
  R3_HTTP_MISSING_PRODUCTION_SEAMS,
  R3_HTTP_SECURITY_CASES,
  verifyR3HttpSecurityMatrix,
  type R3HttpBoundaryResult,
  type R3HttpSecurityCase,
  type R3HttpSecurityMatrixAdapter,
} from "../src/r3-demand-side-http-security.js";

describe("R3 demand-side HTTP security contract", () => {
  it("verifies only the existing Fastify surfaces and names missing seams", async () => {
    const report = await verifyR3HttpSecurityMatrix(validAdapter());
    const commandCount = R3_HTTP_SECURITY_CASES.filter(
      ({ action }) => action === "COMMAND",
    ).length;
    expect(report).toEqual({
      anonymousProbes: 8,
      commandCsrfChecks: commandCount * 2,
      databaseAuthorization: "PROVEN_SEPARATELY_BY_STAGE_ONE_LIVE_PG",
      missingProductionSeams: R3_HTTP_MISSING_PRODUCTION_SEAMS,
      probes: R3_HTTP_SECURITY_CASES.length,
      status: "FASTIFY_TRANSPORT_VERIFIED",
    });
    expect(R3_HTTP_SECURITY_CASES).toHaveLength(400);
  });

  it("rejects adapters which ignore target lineage or terminal state", async () => {
    await expect(
      verifyR3HttpSecurityMatrix(
        validAdapter((testCase, result) => {
          const actorOwner =
            testCase.actor === "CUSTOMER_OWNER" ||
            testCase.actor === "PROVIDER_OWNER";
          return decisionResult(testCase, actorOwner, "APPLIED", result);
        }),
      ),
    ).rejects.toThrow(/decision mismatch/u);

    await expect(
      verifyR3HttpSecurityMatrix(
        validAdapter((testCase, result) =>
          testCase.target === "EXACT_OWN" &&
          (testCase.actor === "CUSTOMER_OWNER" ||
            testCase.actor === "PROVIDER_OWNER")
            ? decisionResult(testCase, true, "APPLIED", result)
            : result,
        ),
      ),
    ).rejects.toThrow(/decision mismatch|Unexpected command effect/u);
  });

  it("requires real missing-token and wrong-token no-effect evidence", async () => {
    await expect(
      verifyR3HttpSecurityMatrix(
        validAdapter((testCase, result) =>
          testCase.action === "COMMAND" && "csrfMissing" in result
            ? {
                ...result,
                csrfMissing: {
                  ...result.csrfMissing,
                  effectCountAfter: 1,
                },
              }
            : result,
        ),
      ),
    ).rejects.toThrow(/created or omitted effect evidence/u);
  });

  it("rejects cacheable, indexable or marker-bearing denials", async () => {
    await expect(
      verifyR3HttpSecurityMatrix(
        validAdapter((_testCase, result) => ({
          ...result,
          headers: { ...result.headers, "cache-control": "public" },
        })),
      ),
    ).rejects.toThrow(/headers are unsafe/u);
    await expect(
      verifyR3HttpSecurityMatrix(
        validAdapter((testCase, result) =>
          testCase.expectedAllowed
            ? result
            : { ...result, body: { code: "NOT_FOUND", value: privateMarker } },
        ),
      ),
    ).rejects.toThrow(/private marker/u);
  });

  it("rejects anonymous access and credentialed CORS widening", async () => {
    await expect(
      verifyR3HttpSecurityMatrix({
        ...validAdapter(),
        probeAnonymous: () =>
          Promise.resolve(response(200, {}, undefined, undefined)),
      }),
    ).rejects.toThrow(/Anonymous R3 route/u);
    await expect(
      verifyR3HttpSecurityMatrix({
        ...validAdapter(),
        probeCors: () =>
          Promise.resolve({
            allowedOrigin,
            allowedPreflight: response(204, {}, undefined, undefined, {
              "access-control-allow-credentials": "true",
              "access-control-allow-origin": "*",
            }),
            disallowedPreflight: response(204, {}, undefined, undefined),
          }),
      }),
    ).rejects.toThrow(/CORS evidence/u);
  });
});

const privateMarker = "R3_HTTP_PRIVATE_CANARY_022";
const allowedOrigin = "https://portal.example.test";

function validAdapter(
  mutate: (
    testCase: R3HttpSecurityCase,
    result: Awaited<ReturnType<R3HttpSecurityMatrixAdapter["probe"]>>,
  ) => Awaited<ReturnType<R3HttpSecurityMatrixAdapter["probe"]>> = (
    _testCase,
    result,
  ) => result,
): R3HttpSecurityMatrixAdapter {
  return {
    privateMarkers: [privateMarker],
    probe(testCase) {
      return Promise.resolve(mutate(testCase, expectedResult(testCase)));
    },
    probeAnonymous(testCase) {
      return Promise.resolve(
        response(
          401,
          { code: "AUTHENTICATION_REQUIRED" },
          testCase.action === "COMMAND" ? 0 : undefined,
          testCase.action === "COMMAND" ? 0 : undefined,
        ),
      );
    },
    probeCors() {
      return Promise.resolve({
        allowedOrigin,
        allowedPreflight: response(204, {}, undefined, undefined, {
          "access-control-allow-credentials": "true",
          "access-control-allow-origin": allowedOrigin,
        }),
        disallowedPreflight: response(204, {}, undefined, undefined),
      });
    },
  };
}

function expectedResult(testCase: R3HttpSecurityCase) {
  const suspended =
    testCase.actor === "SUSPENDED_CUSTOMER_OWNER" ||
    testCase.actor === "SUSPENDED_PROVIDER_OWNER";
  const statusCode = suspended
    ? 403
    : testCase.expectedOutcome === "READ_ONLY"
      ? 409
      : testCase.expectedAllowed
        ? testCase.action === "COMMAND"
          ? 201
          : 200
        : 404;
  const body = suspended
    ? { code: "ACCOUNT_NOT_ACTIVE" }
    : testCase.expectedOutcome === "READ_ONLY"
      ? { code: "CONVERSATION_READ_ONLY" }
      : testCase.expectedAllowed
        ? {}
        : { code: "NOT_FOUND" };
  const main = response(
    statusCode,
    body,
    testCase.action === "COMMAND" ? 0 : undefined,
    testCase.action === "COMMAND" && testCase.expectedAllowed ? 1 : 0,
  );
  return testCase.action === "COMMAND"
    ? {
        ...main,
        csrfMissing: response(403, { code: "CSRF_INVALID" }, 0, 0),
        csrfWrong: response(403, { code: "CSRF_INVALID" }, 0, 0),
      }
    : main;
}

function decisionResult(
  testCase: R3HttpSecurityCase,
  allowed: boolean,
  outcome: "APPLIED" | "READ_ONLY",
  prior: Awaited<ReturnType<R3HttpSecurityMatrixAdapter["probe"]>>,
) {
  if (!allowed) return response(404, { code: "NOT_FOUND" }, 0, 0);
  if (outcome === "READ_ONLY") {
    return response(409, { code: "CONVERSATION_READ_ONLY" }, 0, 0);
  }
  const main = response(
    testCase.action === "COMMAND" ? 201 : 200,
    {},
    testCase.action === "COMMAND" ? 0 : undefined,
    testCase.action === "COMMAND" ? 1 : undefined,
  );
  return testCase.action === "COMMAND" && "csrfMissing" in prior
    ? { ...main, csrfMissing: prior.csrfMissing, csrfWrong: prior.csrfWrong }
    : main;
}

function response(
  statusCode: number,
  body: unknown,
  effectCountBefore: number | undefined,
  effectCountAfter: number | undefined,
  headers: Readonly<Record<string, string | undefined>> = {},
): R3HttpBoundaryResult {
  return {
    body,
    ...(effectCountAfter === undefined ? {} : { effectCountAfter }),
    ...(effectCountBefore === undefined ? {} : { effectCountBefore }),
    headers: {
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
      ...headers,
    },
    statusCode,
  };
}
