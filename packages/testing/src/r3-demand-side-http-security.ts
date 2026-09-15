import {
  R3_DATABASE_SECURITY_CASES,
  type R3DatabaseSecurityCase,
} from "./r3-demand-side-security.js";

export const R3_HTTP_TESTED_SURFACES = Object.freeze([
  "INVITATION_DETAIL",
  "CONVERSATION",
  "CONVERSATION_TIMELINE",
  "CONVERSATION_WRITE",
  "QUOTE_COMPARISON",
] as const);

export const R3_HTTP_MISSING_PRODUCTION_SEAMS = Object.freeze([
  "QUOTE_CORE_HTTP",
  "QUOTE_STRUCTURED_AUTHORING_HTTP",
  "QUOTE_EXTERNAL_PDF_AUTHORING_HTTP",
  "PRIVATE_MEDIA_PRODUCTION_COMPOSITION",
  "JOB_REQUEST_PRIVATE_MEDIA_DELIVERY",
  "BROWSER_STAGING_E2E",
] as const);

export type R3HttpTestedSurface = (typeof R3_HTTP_TESTED_SURFACES)[number];
export type R3HttpMissingProductionSeam =
  (typeof R3_HTTP_MISSING_PRODUCTION_SEAMS)[number];

export interface R3HttpSecurityCase extends R3DatabaseSecurityCase {
  readonly surface: R3HttpTestedSurface;
}

export interface R3HttpBoundaryResult {
  readonly body: unknown;
  readonly effectCountAfter?: number;
  readonly effectCountBefore?: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly statusCode: number;
}

export interface R3HttpCommandProbeResult extends R3HttpBoundaryResult {
  readonly csrfMissing: R3HttpBoundaryResult;
  readonly csrfWrong: R3HttpBoundaryResult;
}

export interface R3HttpCorsEvidence {
  readonly allowedOrigin: string;
  readonly allowedPreflight: R3HttpBoundaryResult;
  readonly disallowedPreflight: R3HttpBoundaryResult;
}

export interface R3HttpSecurityMatrixAdapter {
  /** Synthetic canaries only; credentials must never be supplied here. */
  readonly privateMarkers: readonly string[];
  probe(
    testCase: R3HttpSecurityCase,
  ): Promise<R3HttpBoundaryResult | R3HttpCommandProbeResult>;
  probeAnonymous(testCase: R3HttpSecurityCase): Promise<R3HttpBoundaryResult>;
  probeCors(): Promise<R3HttpCorsEvidence>;
}

export interface R3HttpSecurityReport {
  readonly anonymousProbes: number;
  readonly commandCsrfChecks: number;
  readonly databaseAuthorization: "PROVEN_SEPARATELY_BY_STAGE_ONE_LIVE_PG";
  readonly missingProductionSeams: readonly R3HttpMissingProductionSeam[];
  readonly probes: number;
  readonly status: "FASTIFY_TRANSPORT_VERIFIED";
}

export const R3_HTTP_SECURITY_CASES: readonly R3HttpSecurityCase[] =
  Object.freeze(
    R3_DATABASE_SECURITY_CASES.filter(
      (testCase): testCase is R3HttpSecurityCase =>
        R3_HTTP_TESTED_SURFACES.some((surface) => surface === testCase.surface),
    ),
  );

const anonymousCases = Object.freeze(
  R3_HTTP_SECURITY_CASES.filter(
    (testCase, index, cases) =>
      testCase.target === "EXACT_OWN" &&
      testCase.actor === "CUSTOMER_OWNER" &&
      cases.findIndex(
        (candidate) =>
          candidate.surface === testCase.surface &&
          candidate.state === testCase.state,
      ) === index,
  ),
);

export async function verifyR3HttpSecurityMatrix(
  adapter: R3HttpSecurityMatrixAdapter,
): Promise<R3HttpSecurityReport> {
  assertMarkers(adapter.privateMarkers);
  assertDefinition();
  let commandCsrfChecks = 0;
  for (const testCase of R3_HTTP_SECURITY_CASES) {
    const result = await adapter.probe(testCase);
    assertPrivateHeaders(result, testCase.id);
    assertHttpDecision(testCase, result);
    assertNoPrivateMarkersOnDenial(testCase, result, adapter.privateMarkers);
    if (testCase.action === "COMMAND") {
      assertCommandEffect(testCase, result);
      if (!("csrfMissing" in result) || !("csrfWrong" in result)) {
        throw new Error(`Missing CSRF evidence for ${testCase.id}.`);
      }
      assertCsrfDenial(result.csrfMissing, `${testCase.id}:missing`);
      assertCsrfDenial(result.csrfWrong, `${testCase.id}:wrong`);
      commandCsrfChecks += 2;
    }
  }

  for (const testCase of anonymousCases) {
    const result = await adapter.probeAnonymous(testCase);
    assertPrivateHeaders(result, `${testCase.id}:anonymous`);
    if (
      result.statusCode !== 401 ||
      responseCode(result.body) !== "AUTHENTICATION_REQUIRED"
    ) {
      throw new Error(
        `Anonymous R3 route was not denied for ${testCase.id}: received ${result.statusCode}/${responseCode(result.body) ?? "no-code"}.`,
      );
    }
    if (testCase.action === "COMMAND") assertNoEffect(result, testCase.id);
  }
  assertCors(await adapter.probeCors());

  return Object.freeze({
    anonymousProbes: anonymousCases.length,
    commandCsrfChecks,
    databaseAuthorization: "PROVEN_SEPARATELY_BY_STAGE_ONE_LIVE_PG" as const,
    missingProductionSeams: R3_HTTP_MISSING_PRODUCTION_SEAMS,
    probes: R3_HTTP_SECURITY_CASES.length,
    status: "FASTIFY_TRANSPORT_VERIFIED" as const,
  });
}

function assertHttpDecision(
  testCase: R3HttpSecurityCase,
  result: R3HttpBoundaryResult,
): void {
  const expectation = expectedHttpDecision(testCase);
  if (
    result.statusCode !== expectation.statusCode ||
    (expectation.code !== null &&
      responseCode(result.body) !== expectation.code)
  ) {
    throw new Error(
      `R3 HTTP decision mismatch for ${testCase.id}: expected ${expectation.statusCode}/${expectation.code ?? "success"}.`,
    );
  }
}

function expectedHttpDecision(testCase: R3HttpSecurityCase): Readonly<{
  code: string | null;
  statusCode: number;
}> {
  if (
    testCase.actor === "SUSPENDED_CUSTOMER_OWNER" ||
    testCase.actor === "SUSPENDED_PROVIDER_OWNER"
  ) {
    return { code: "ACCOUNT_NOT_ACTIVE", statusCode: 403 };
  }
  if (testCase.expectedOutcome === "READ_ONLY") {
    return { code: "CONVERSATION_READ_ONLY", statusCode: 409 };
  }
  if (!testCase.expectedAllowed) {
    return { code: "NOT_FOUND", statusCode: 404 };
  }
  return {
    code: null,
    statusCode: testCase.action === "COMMAND" ? 201 : 200,
  };
}

function assertCommandEffect(
  testCase: R3HttpSecurityCase,
  result: R3HttpBoundaryResult,
): void {
  if (
    result.effectCountBefore === undefined ||
    result.effectCountAfter === undefined
  ) {
    throw new Error(`Missing command effect evidence for ${testCase.id}.`);
  }
  const expectedDelta = testCase.expectedAllowed ? 1 : 0;
  if (result.effectCountAfter - result.effectCountBefore !== expectedDelta) {
    throw new Error(`Unexpected command effect for ${testCase.id}.`);
  }
}

function assertCsrfDenial(result: R3HttpBoundaryResult, label: string): void {
  assertPrivateHeaders(result, label);
  if (
    result.statusCode !== 403 ||
    responseCode(result.body) !== "CSRF_INVALID"
  ) {
    throw new Error(`R3 CSRF denial mismatch for ${label}.`);
  }
  assertNoEffect(result, label);
}

function assertNoEffect(result: R3HttpBoundaryResult, label: string): void {
  if (
    result.effectCountBefore === undefined ||
    result.effectCountAfter === undefined ||
    result.effectCountBefore !== result.effectCountAfter
  ) {
    throw new Error(
      `R3 denied request created or omitted effect evidence: ${label}.`,
    );
  }
}

function assertPrivateHeaders(
  result: R3HttpBoundaryResult,
  label: string,
): void {
  if (
    !result.headers["cache-control"]?.includes("no-store") ||
    result.headers["x-robots-tag"] !== "noindex, nofollow"
  ) {
    throw new Error(`R3 private response headers are unsafe for ${label}.`);
  }
}

function assertNoPrivateMarkersOnDenial(
  testCase: R3HttpSecurityCase,
  result: R3HttpBoundaryResult,
  markers: readonly string[],
): void {
  if (testCase.expectedAllowed && result.statusCode < 400) return;
  const serialized = JSON.stringify(result.body) ?? "undefined";
  if (markers.some((marker) => serialized.includes(marker))) {
    throw new Error(
      `R3 HTTP denial leaked a private marker for ${testCase.id}.`,
    );
  }
}

function assertCors(evidence: R3HttpCorsEvidence): void {
  if (
    evidence.allowedPreflight.headers["access-control-allow-origin"] !==
      evidence.allowedOrigin ||
    evidence.allowedPreflight.headers["access-control-allow-credentials"] !==
      "true" ||
    evidence.disallowedPreflight.headers["access-control-allow-origin"] !==
      undefined
  ) {
    throw new Error("R3 credentialed CORS evidence is invalid.");
  }
}

function responseCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("code" in body)) {
    return null;
  }
  return typeof body.code === "string" ? body.code : null;
}

function assertMarkers(markers: readonly string[]): void {
  if (
    markers.length === 0 ||
    markers.some(
      (marker) =>
        typeof marker !== "string" ||
        marker.length < 8 ||
        marker.length > 500 ||
        /[\r\n]/u.test(marker),
    )
  ) {
    throw new TypeError("R3 HTTP markers must be bounded synthetic values.");
  }
}

function assertDefinition(): void {
  if (R3_HTTP_SECURITY_CASES.length === 0) {
    throw new Error("R3 HTTP security matrix is empty.");
  }
  const ids = new Set(R3_HTTP_SECURITY_CASES.map(({ id }) => id));
  if (ids.size !== R3_HTTP_SECURITY_CASES.length) {
    throw new Error("R3 HTTP security matrix contains duplicate cases.");
  }
}
