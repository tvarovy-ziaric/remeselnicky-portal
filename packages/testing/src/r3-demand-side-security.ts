export const R3_SECURITY_ACTORS = Object.freeze([
  "CUSTOMER_OWNER",
  "PROVIDER_OWNER",
  "COMPETING_PROVIDER",
  "UNRELATED_CUSTOMER",
  "UNINVITED_PROVIDER",
  "UNRELATED_COMBINED",
  "ADMIN_ROLE_ONLY",
  "SUPERADMIN_ROLE_ONLY",
  "SUSPENDED_CUSTOMER_OWNER",
  "SUSPENDED_PROVIDER_OWNER",
] as const);

export const R3_SECURITY_TARGETS = Object.freeze([
  "EXACT_OWN",
  "COMPETITOR_SAME_REQUEST",
  "FOREIGN_REQUEST",
  "UNKNOWN_UUID",
  "WRONG_KIND_UUID",
] as const);

export const R3_DATABASE_SECURITY_SURFACES = Object.freeze([
  "INVITATION_DETAIL",
  "CONVERSATION",
  "CONVERSATION_TIMELINE",
  "CONVERSATION_WRITE",
  "CHAT_ATTACHMENT",
  "QUOTE_CORE",
  "QUOTE_STRUCTURED_REVISION",
  "QUOTE_EXTERNAL_REVISION",
  "QUOTE_COMPARISON",
  "QUOTE_PDF_CURRENT",
  "QUOTE_PDF_REPLACED",
] as const);

export const R3_SECURITY_STATES = Object.freeze([
  "CURRENT",
  "WRITABLE",
  "TERMINAL_LINEAGE",
  "PROVIDER_DRAFT",
  "SUBMITTED_OR_HISTORICAL",
  "CURRENT_SUBMITTED",
] as const);

export const R3_STAGE_ONE_MISSING_SEAMS = Object.freeze([
  "JOB_REQUEST_PRIVATE_MEDIA_DELIVERY",
  "QUOTE_AUTHORING_HTTP",
  "QUOTE_AUTHORING_UI",
  "PRODUCTION_PRIVATE_MEDIA_COMPOSITION",
  "BROWSER_E2E_RUNNER",
] as const);

export type R3SecurityActor = (typeof R3_SECURITY_ACTORS)[number];
export type R3SecurityTarget = (typeof R3_SECURITY_TARGETS)[number];
export type R3DatabaseSecuritySurface =
  (typeof R3_DATABASE_SECURITY_SURFACES)[number];
export type R3SecurityState = (typeof R3_SECURITY_STATES)[number];
export type R3StageOneMissingSeam = (typeof R3_STAGE_ONE_MISSING_SEAMS)[number];
export type R3SecurityAction = "COMMAND" | "DOWNLOAD" | "READ";
export type R3SecurityOutcome =
  "APPLIED" | "FOUND" | "GRANTED" | "NOT_FOUND" | "READ_ONLY";

export interface R3DatabaseSecurityCase {
  readonly action: R3SecurityAction;
  readonly actor: R3SecurityActor;
  readonly expectedAllowed: boolean;
  readonly expectedOutcome: R3SecurityOutcome;
  readonly id: string;
  readonly state: R3SecurityState;
  readonly surface: R3DatabaseSecuritySurface;
  readonly target: R3SecurityTarget;
}

export interface R3DatabaseBoundaryProbeResult {
  readonly evaluation: "EVALUATED";
  readonly allowed: boolean;
  readonly effectCountAfter?: number;
  readonly effectCountBefore?: number;
  readonly outcome: R3SecurityOutcome;
  readonly payload?: unknown;
}

export interface R3DatabaseBoundaryNotEvaluated {
  readonly evaluation: "NOT_EVALUATED";
  readonly reason: string;
}

export type R3DatabaseBoundaryProbeEvidence =
  R3DatabaseBoundaryNotEvaluated | R3DatabaseBoundaryProbeResult;

export interface R3DatabaseSecurityMatrixAdapter {
  /** Markers are seeded values, never production data. */
  readonly competitorMarkers: readonly string[];
  readonly privateMarkers: readonly string[];
  probe(
    testCase: R3DatabaseSecurityCase,
  ): Promise<R3DatabaseBoundaryProbeEvidence>;
}

export interface R3StageOneSecurityReport {
  readonly browser: Readonly<{
    readonly missingSeams: readonly R3StageOneMissingSeam[];
    readonly status: "NOT_EVALUATED";
  }>;
  readonly database: Readonly<{
    readonly declaredProbes: number;
    readonly deniedCommandNoEffectChecks: number;
    readonly deniedProbes: number;
    readonly evaluatedProbes: number;
    readonly notEvaluatedCaseIds: readonly string[];
    readonly positiveProbes: number;
    readonly status: "PARTIALLY_VERIFIED" | "VERIFIED";
  }>;
  readonly http: Readonly<{
    readonly missingSeams: readonly R3StageOneMissingSeam[];
    readonly status: "NOT_EVALUATED";
  }>;
}

type ParticipantRole = "CUSTOMER" | "PROVIDER";

interface SurfacePolicy {
  readonly action: R3SecurityAction;
  readonly allowedRoles: readonly ParticipantRole[];
  readonly allowedOutcome: R3SecurityOutcome;
  readonly readOnlyRoles: readonly ParticipantRole[];
  readonly state: R3SecurityState;
  readonly surface: R3DatabaseSecuritySurface;
}

const bilateralRoles = Object.freeze(["CUSTOMER", "PROVIDER"] as const);
const customerRole = Object.freeze(["CUSTOMER"] as const);
const providerRole = Object.freeze(["PROVIDER"] as const);
const noRoles = Object.freeze([] as const satisfies readonly ParticipantRole[]);

const surfacePolicies = Object.freeze([
  policy("INVITATION_DETAIL", "READ", "CURRENT", bilateralRoles, "FOUND"),
  policy("CONVERSATION", "READ", "WRITABLE", bilateralRoles, "FOUND"),
  policy("CONVERSATION", "READ", "TERMINAL_LINEAGE", bilateralRoles, "FOUND"),
  policy("CONVERSATION_TIMELINE", "READ", "WRITABLE", bilateralRoles, "FOUND"),
  policy(
    "CONVERSATION_TIMELINE",
    "READ",
    "TERMINAL_LINEAGE",
    bilateralRoles,
    "FOUND",
  ),
  policy(
    "CONVERSATION_WRITE",
    "COMMAND",
    "WRITABLE",
    bilateralRoles,
    "APPLIED",
  ),
  policy(
    "CONVERSATION_WRITE",
    "COMMAND",
    "TERMINAL_LINEAGE",
    noRoles,
    "APPLIED",
    bilateralRoles,
  ),
  policy("CHAT_ATTACHMENT", "DOWNLOAD", "WRITABLE", bilateralRoles, "GRANTED"),
  policy(
    "CHAT_ATTACHMENT",
    "DOWNLOAD",
    "TERMINAL_LINEAGE",
    bilateralRoles,
    "GRANTED",
  ),
  policy(
    "QUOTE_CORE",
    "READ",
    "SUBMITTED_OR_HISTORICAL",
    bilateralRoles,
    "FOUND",
  ),
  policy(
    "QUOTE_STRUCTURED_REVISION",
    "READ",
    "PROVIDER_DRAFT",
    providerRole,
    "FOUND",
  ),
  policy(
    "QUOTE_STRUCTURED_REVISION",
    "READ",
    "SUBMITTED_OR_HISTORICAL",
    bilateralRoles,
    "FOUND",
  ),
  policy(
    "QUOTE_EXTERNAL_REVISION",
    "READ",
    "PROVIDER_DRAFT",
    providerRole,
    "FOUND",
  ),
  policy(
    "QUOTE_EXTERNAL_REVISION",
    "READ",
    "SUBMITTED_OR_HISTORICAL",
    bilateralRoles,
    "FOUND",
  ),
  policy(
    "QUOTE_COMPARISON",
    "READ",
    "CURRENT_SUBMITTED",
    customerRole,
    "FOUND",
  ),
  policy(
    "QUOTE_PDF_CURRENT",
    "DOWNLOAD",
    "PROVIDER_DRAFT",
    providerRole,
    "GRANTED",
  ),
  policy(
    "QUOTE_PDF_CURRENT",
    "DOWNLOAD",
    "SUBMITTED_OR_HISTORICAL",
    bilateralRoles,
    "GRANTED",
  ),
  policy(
    "QUOTE_PDF_REPLACED",
    "DOWNLOAD",
    "PROVIDER_DRAFT",
    providerRole,
    "GRANTED",
  ),
  policy(
    "QUOTE_PDF_REPLACED",
    "DOWNLOAD",
    "SUBMITTED_OR_HISTORICAL",
    providerRole,
    "GRANTED",
  ),
] satisfies readonly SurfacePolicy[]);

export const R3_DATABASE_SECURITY_CASES: readonly R3DatabaseSecurityCase[] =
  Object.freeze(
    surfacePolicies.flatMap((surface) =>
      R3_SECURITY_TARGETS.flatMap((target) =>
        R3_SECURITY_ACTORS.map((actor) => {
          const role = participantRole(actor, target);
          const expectedAllowed =
            role !== null && surface.allowedRoles.includes(role);
          const expectedOutcome = expectedAllowed
            ? surface.allowedOutcome
            : role !== null && surface.readOnlyRoles.includes(role)
              ? "READ_ONLY"
              : "NOT_FOUND";
          return Object.freeze({
            action: surface.action,
            actor,
            expectedAllowed,
            expectedOutcome,
            id: `${surface.surface}:${surface.state}:${surface.action}:${target}:${actor}`,
            state: surface.state,
            surface: surface.surface,
            target,
          });
        }),
      ),
    ),
  );

const forbiddenKeyFragments = Object.freeze([
  "addressline",
  "contentsha",
  "exactaddress",
  "latitude",
  "longitude",
  "malwarescan",
  "normalizedemail",
  "normalizedphone",
  "passwordhash",
  "signedurl",
  "storagekey",
] as const);

/**
 * Verifies the database half of R3-022 without turning absent fixtures or
 * missing HTTP/browser seams into synthetic pass evidence.
 */
export async function verifyR3DatabaseSecurityMatrix(
  adapter: R3DatabaseSecurityMatrixAdapter,
): Promise<R3StageOneSecurityReport> {
  assertMarkers(adapter.privateMarkers, "private");
  assertMarkers(adapter.competitorMarkers, "competitor");
  assertMatrixDefinition();

  let deniedProbes = 0;
  let positiveProbes = 0;
  let deniedCommandNoEffectChecks = 0;
  const notEvaluatedCaseIds: string[] = [];
  for (const testCase of R3_DATABASE_SECURITY_CASES) {
    const result = await adapter.probe(testCase);
    if (result.evaluation === "NOT_EVALUATED") {
      if (result.reason.trim().length === 0) {
        throw new Error(`Missing NOT_EVALUATED reason for ${testCase.id}.`);
      }
      notEvaluatedCaseIds.push(testCase.id);
      continue;
    }
    if (
      result.allowed !== testCase.expectedAllowed ||
      result.outcome !== testCase.expectedOutcome
    ) {
      throw new Error(
        `R3 security decision mismatch for ${testCase.id}: expected ${
          testCase.expectedAllowed ? "allow" : "deny"
        }/${testCase.expectedOutcome}.`,
      );
    }

    assertNoForbiddenPrivateKeys(result.payload);
    if (testCase.expectedAllowed) {
      positiveProbes += 1;
      assertProviderIsolation(testCase, result.payload, adapter);
      continue;
    }

    deniedProbes += 1;
    assertNoMarkers(result.payload, adapter.privateMarkers, testCase.id);
    assertNoMarkers(result.payload, adapter.competitorMarkers, testCase.id);
    if (testCase.action === "COMMAND") {
      if (
        result.effectCountBefore === undefined ||
        result.effectCountAfter === undefined ||
        result.effectCountAfter !== result.effectCountBefore
      ) {
        throw new Error(
          `Denied R3 command created or omitted effect evidence for ${testCase.id}.`,
        );
      }
      deniedCommandNoEffectChecks += 1;
    }
  }

  const evaluatedProbes =
    R3_DATABASE_SECURITY_CASES.length - notEvaluatedCaseIds.length;
  return Object.freeze({
    browser: Object.freeze({
      missingSeams: R3_STAGE_ONE_MISSING_SEAMS,
      status: "NOT_EVALUATED" as const,
    }),
    database: Object.freeze({
      declaredProbes: R3_DATABASE_SECURITY_CASES.length,
      deniedCommandNoEffectChecks,
      deniedProbes,
      evaluatedProbes,
      notEvaluatedCaseIds: Object.freeze(notEvaluatedCaseIds),
      positiveProbes,
      status:
        notEvaluatedCaseIds.length === 0
          ? ("VERIFIED" as const)
          : ("PARTIALLY_VERIFIED" as const),
    }),
    http: Object.freeze({
      missingSeams: R3_STAGE_ONE_MISSING_SEAMS,
      status: "NOT_EVALUATED" as const,
    }),
  });
}

function policy(
  surface: R3DatabaseSecuritySurface,
  action: R3SecurityAction,
  state: R3SecurityState,
  allowedRoles: readonly ParticipantRole[],
  allowedOutcome: R3SecurityOutcome,
  readOnlyRoles: readonly ParticipantRole[] = noRoles,
): SurfacePolicy {
  return Object.freeze({
    action,
    allowedRoles,
    allowedOutcome,
    readOnlyRoles,
    state,
    surface,
  });
}

function participantRole(
  actor: R3SecurityActor,
  target: R3SecurityTarget,
): ParticipantRole | null {
  if (target === "EXACT_OWN") {
    if (actor === "CUSTOMER_OWNER") return "CUSTOMER";
    if (actor === "PROVIDER_OWNER") return "PROVIDER";
  }
  if (target === "COMPETITOR_SAME_REQUEST") {
    if (actor === "CUSTOMER_OWNER") return "CUSTOMER";
    if (actor === "COMPETING_PROVIDER") return "PROVIDER";
  }
  return null;
}

function assertMatrixDefinition(): void {
  const expectedCount =
    surfacePolicies.length *
    R3_SECURITY_TARGETS.length *
    R3_SECURITY_ACTORS.length;
  if (R3_DATABASE_SECURITY_CASES.length !== expectedCount) {
    throw new Error("R3 security matrix is incomplete.");
  }
  const ids = new Set(R3_DATABASE_SECURITY_CASES.map(({ id }) => id));
  if (ids.size !== expectedCount) {
    throw new Error("R3 security matrix contains duplicate cases.");
  }
}

function assertProviderIsolation(
  testCase: R3DatabaseSecurityCase,
  payload: unknown,
  adapter: R3DatabaseSecurityMatrixAdapter,
): void {
  const role = participantRole(testCase.actor, testCase.target);
  if (role !== "PROVIDER") return;
  if (testCase.target === "EXACT_OWN") {
    assertNoMarkers(
      payload,
      adapter.competitorMarkers,
      `${testCase.id} competitor`,
    );
  } else if (testCase.target === "COMPETITOR_SAME_REQUEST") {
    assertNoMarkers(payload, adapter.privateMarkers, `${testCase.id} foreign`);
  }
}

function assertMarkers(markers: readonly string[], label: string): void {
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
    throw new TypeError(
      `R3 ${label} markers must be non-empty, bounded synthetic values.`,
    );
  }
}

function assertNoMarkers(
  value: unknown,
  markers: readonly string[],
  label: string,
): void {
  const serialized = JSON.stringify(value) ?? "undefined";
  for (const marker of markers) {
    if (serialized.includes(marker)) {
      throw new Error(`R3 ${label} payload leaked a seeded private marker.`);
    }
  }
}

function assertNoForbiddenPrivateKeys(value: unknown): void {
  visit(value);
}

function visit(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) visit(child);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (
      forbiddenKeyFragments.some((fragment) => normalized.includes(fragment))
    ) {
      throw new Error(`R3 payload contains forbidden private field: ${key}.`);
    }
    visit(child);
  }
}
