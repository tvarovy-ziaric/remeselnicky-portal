import { assertUniformNotFound } from "./authorization-harness.js";
import type { TestHttpResponse } from "./http.js";

export const R1_PUBLIC_PROFILE_SCENARIOS = Object.freeze([
  "PUBLIC_APPROVED",
  "DRAFT",
  "OWNER_HIDDEN",
  "MODERATION_HIDDEN",
  "SUSPENDED",
  "UNKNOWN",
] as const);
export const R1_OWNER_SURFACES = Object.freeze([
  "PROFILE",
  "PROFESSIONS",
  "CAPABILITIES",
  "SERVICE_AREA",
  "INDICATIVE_PRICING",
  "EXPERIENCE",
  "AVAILABILITY",
  "CREDENTIAL_CLAIMS",
  "PORTFOLIO_PROJECTS",
  "PORTFOLIO_PHOTOS",
  "PORTFOLIO_COLLABORATIONS",
  "FEATURED_PROJECTS",
  "PUBLICATION_CONTROL",
] as const);
export const R1_OWNER_BOUNDARY_ACTORS = Object.freeze([
  "OWNER",
  "FOREIGN",
  "ADMIN_ROLE_ONLY",
  "SUPERADMIN_ROLE_ONLY",
  "SUSPENDED",
] as const);
export const R1_OWNER_ACTIONS = Object.freeze([
  "OWNER_READ",
  "OWNER_COMMAND",
] as const);
export const R1_OWNER_COMMAND_ACCEPTED_OUTCOMES = Object.freeze({
  PROFILE: Object.freeze(["UPDATED"] as const),
  PROFESSIONS: Object.freeze(["APPLIED"] as const),
  CAPABILITIES: Object.freeze(["APPLIED"] as const),
  SERVICE_AREA: Object.freeze(["APPLIED"] as const),
  INDICATIVE_PRICING: Object.freeze(["APPLIED"] as const),
  EXPERIENCE: Object.freeze(["APPLIED"] as const),
  AVAILABILITY: Object.freeze(["APPLIED"] as const),
  CREDENTIAL_CLAIMS: Object.freeze(["APPLIED"] as const),
  PORTFOLIO_PROJECTS: Object.freeze(["APPLIED"] as const),
  // A one-photo fixture has no distinct valid order to apply.
  PORTFOLIO_PHOTOS: Object.freeze(["UNCHANGED"] as const),
  PORTFOLIO_COLLABORATIONS: Object.freeze(["APPLIED"] as const),
  FEATURED_PROJECTS: Object.freeze(["APPLIED"] as const),
  // Reasserting the already-public owner choice is intentionally idempotent.
  PUBLICATION_CONTROL: Object.freeze(["UNCHANGED"] as const),
} satisfies Readonly<Record<R1OwnerSurface, readonly string[]>>);
export const R1_PRIVILEGED_REVIEW_SURFACES = Object.freeze([
  "PROFILE_REVIEW",
  "CREDENTIAL_REVIEW",
] as const);
export const R1_PRIVILEGED_REVIEW_ACTORS = Object.freeze([
  "MFA_CAPABILITY_ACTOR",
  "OWNER",
  "ADMIN_ROLE_ONLY",
  "SUPERADMIN_ROLE_ONLY",
  "SUSPENDED",
] as const);
export const R1_PORTFOLIO_DELIVERY_SCENARIOS = Object.freeze([
  "EXACT_PUBLIC_INTERSECTION",
  "PROFILE_HIDDEN",
  "PROJECT_HIDDEN",
  "SOURCE_MISMATCH",
  "OBJECT_REVOKED",
] as const);

export type R1PublicProfileScenario =
  (typeof R1_PUBLIC_PROFILE_SCENARIOS)[number];
export type R1OwnerSurface = (typeof R1_OWNER_SURFACES)[number];
export type R1OwnerBoundaryActor = (typeof R1_OWNER_BOUNDARY_ACTORS)[number];
export type R1OwnerAction = (typeof R1_OWNER_ACTIONS)[number];
export type R1PrivilegedReviewSurface =
  (typeof R1_PRIVILEGED_REVIEW_SURFACES)[number];
export type R1PrivilegedReviewActor =
  (typeof R1_PRIVILEGED_REVIEW_ACTORS)[number];
export type R1PortfolioDeliveryScenario =
  (typeof R1_PORTFOLIO_DELIVERY_SCENARIOS)[number];

export interface R1BoundaryProbeResult {
  readonly allowed: boolean;
  /** Actual bounded repository/authorizer outcome, when the probe has one. */
  readonly outcome?: string;
  readonly payload?: unknown;
}

export interface R1CommandRaceEvidence {
  readonly cas: Readonly<{
    effectCount: number;
    outcomes: readonly [
      "APPLIED" | "STALE_REVISION" | "DENIED",
      "APPLIED" | "STALE_REVISION" | "DENIED",
    ];
  }>;
  readonly idempotency: Readonly<{
    effectCount: number;
    outcomes: readonly [
      "APPLIED" | "DEDUPLICATED" | "DENIED",
      "APPLIED" | "DEDUPLICATED" | "DENIED",
    ];
    retryOutcome: "APPLIED" | "DEDUPLICATED" | "DENIED";
  }>;
}

export interface R1SupplySideMatrixAdapter {
  readonly forbiddenMarkers: readonly string[];
  /** SUSPENDED is the otherwise entitled profile owner after suspension. */
  probeOwnerBoundary(input: {
    readonly action: R1OwnerAction;
    readonly actor: R1OwnerBoundaryActor;
    readonly surface: R1OwnerSurface;
  }): Promise<R1BoundaryProbeResult>;
  probePortfolioDelivery(
    scenario: R1PortfolioDeliveryScenario,
  ): Promise<R1BoundaryProbeResult>;
  /** SUSPENDED is the exact MFA/capability reviewer after suspension. */
  probePrivilegedReview(input: {
    readonly actor: R1PrivilegedReviewActor;
    readonly surface: R1PrivilegedReviewSurface;
  }): Promise<R1BoundaryProbeResult>;
  readPublicProfile(
    scenario: R1PublicProfileScenario,
  ): Promise<TestHttpResponse>;
  runCommandRaces(): Promise<R1CommandRaceEvidence>;
}

export interface R1SupplySideMatrixReport {
  readonly ownerBoundaryProbes: number;
  readonly portfolioDeliveryProbes: number;
  readonly privilegedReviewProbes: number;
  readonly publicProfileProbes: number;
  readonly raceChecks: 2;
}

const forbiddenPublicKeys = new Set(
  [
    "approvedbyuserid",
    "companyregistrationnumber",
    "companyregistrationverificationreference",
    "contentsha256",
    "credentialevidence",
    "email",
    "evidencestoragekey",
    "exactaddress",
    "homeaddress",
    "identityverificationreference",
    "latitude",
    "longitude",
    "moderationstate",
    "owneruserid",
    "phone",
    "rawcompletenesspercent",
    "reviewedbyuserid",
    "reviewreason",
    "reviewstate",
    "riskscore",
    "storagekey",
  ].map((key) => key.toLowerCase()),
);
const publicProfileTopLevelFields = new Set([
  "profileId",
  "identity",
  "professions",
  "location",
  "trust",
  "callToAction",
  "portfolio",
  "skills",
  "specializations",
  "indicativePricing",
  "experience",
  "credentials",
]);
const forbiddenKeyFragments = Object.freeze([
  "address",
  "adminmetadata",
  "contentsha",
  "coordinate",
  "credentialevidence",
  "evidencestorage",
  "latitude",
  "longitude",
  "password",
  "sessiondigest",
  "storagekey",
] as const);

export async function verifyR1SupplySideMatrix(
  adapter: R1SupplySideMatrixAdapter,
): Promise<R1SupplySideMatrixReport> {
  assertMarkers(adapter.forbiddenMarkers);
  const publicResponses = new Map<R1PublicProfileScenario, TestHttpResponse>();
  for (const scenario of R1_PUBLIC_PROFILE_SCENARIOS) {
    publicResponses.set(scenario, await adapter.readPublicProfile(scenario));
  }
  const publicProfile = required(publicResponses, "PUBLIC_APPROVED");
  if (publicProfile.statusCode !== 200) {
    throw new Error("Approved public profile is not publicly readable.");
  }
  assertNoStore(publicProfile);
  assertHeaderContains(publicProfile, "x-robots-tag", "index");
  assertPublicProfileAllowlist(publicProfile.body);
  assertNoPrivateData(publicProfile.body, adapter.forbiddenMarkers);
  const deniedPublic = R1_PUBLIC_PROFILE_SCENARIOS.filter(
    (scenario) => scenario !== "PUBLIC_APPROVED",
  ).map((scenario) => required(publicResponses, scenario));
  assertUniformNotFound(deniedPublic, {
    forbiddenResponseMarkers: adapter.forbiddenMarkers,
  });
  for (const response of deniedPublic) {
    assertHeaderContains(response, "x-robots-tag", "noindex");
    assertNoPrivateData(response.body, adapter.forbiddenMarkers);
  }

  let ownerBoundaryProbes = 0;
  for (const surface of R1_OWNER_SURFACES) {
    for (const action of R1_OWNER_ACTIONS) {
      for (const actor of R1_OWNER_BOUNDARY_ACTORS) {
        const result = await adapter.probeOwnerBoundary({
          action,
          actor,
          surface,
        });
        const shouldAllow = actor === "OWNER";
        assertDecision(result, shouldAllow, `${surface}/${action}/${actor}`);
        if (shouldAllow && action === "OWNER_COMMAND") {
          assertAcceptedOwnerCommandOutcome(surface, result);
        }
        if (!shouldAllow) {
          assertNoPrivateData(result.payload, adapter.forbiddenMarkers);
        }
        ownerBoundaryProbes += 1;
      }
    }
  }

  let privilegedReviewProbes = 0;
  for (const surface of R1_PRIVILEGED_REVIEW_SURFACES) {
    for (const actor of R1_PRIVILEGED_REVIEW_ACTORS) {
      const result = await adapter.probePrivilegedReview({ actor, surface });
      assertDecision(
        result,
        actor === "MFA_CAPABILITY_ACTOR",
        `${surface}/${actor}`,
      );
      if (actor === "MFA_CAPABILITY_ACTOR") {
        if (result.outcome !== "AUTHORIZED") {
          throw new Error(
            `R1 privileged review ${surface} lacked an AUTHORIZED authorizer result.`,
          );
        }
      } else {
        assertNoPrivateData(result.payload, adapter.forbiddenMarkers);
      }
      privilegedReviewProbes += 1;
    }
  }

  let portfolioDeliveryProbes = 0;
  for (const scenario of R1_PORTFOLIO_DELIVERY_SCENARIOS) {
    const result = await adapter.probePortfolioDelivery(scenario);
    assertDecision(
      result,
      scenario === "EXACT_PUBLIC_INTERSECTION",
      `PORTFOLIO_DELIVERY/${scenario}`,
    );
    assertNoPrivateData(result.payload, adapter.forbiddenMarkers);
    portfolioDeliveryProbes += 1;
  }

  assertRaceEvidence(await adapter.runCommandRaces());
  return Object.freeze({
    ownerBoundaryProbes,
    portfolioDeliveryProbes,
    privilegedReviewProbes,
    publicProfileProbes: R1_PUBLIC_PROFILE_SCENARIOS.length,
    raceChecks: 2 as const,
  });
}

export function assertNoPrivateData(
  value: unknown,
  forbiddenMarkers: readonly string[],
): void {
  visit(value);
  const serialized = JSON.stringify(value) ?? "undefined";
  for (const marker of forbiddenMarkers) {
    if (marker.length > 0 && serialized.includes(marker)) {
      throw new Error(
        "R1 public/denial payload leaked a private fixture marker.",
      );
    }
  }
}

function assertPublicProfileAllowlist(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("R1 public profile payload must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!publicProfileTopLevelFields.has(key)) {
      throw new Error(
        `R1 public profile contains a non-allowlisted field: ${key}.`,
      );
    }
  }
  for (const requiredField of publicProfileTopLevelFields) {
    if (!Object.hasOwn(value, requiredField)) {
      throw new Error(
        `R1 public profile omitted allowlisted field: ${requiredField}.`,
      );
    }
  }
}

function visit(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (
      forbiddenPublicKeys.has(normalizedKey) ||
      forbiddenKeyFragments.some((fragment) => normalizedKey.includes(fragment))
    ) {
      throw new Error(`R1 payload contains forbidden private field: ${key}.`);
    }
    visit(child);
  }
}

function assertDecision(
  result: R1BoundaryProbeResult,
  shouldAllow: boolean,
  label: string,
): void {
  if (result.allowed !== shouldAllow) {
    throw new Error(
      `R1 authorization decision mismatch for ${label}: expected ${shouldAllow ? "allow" : "deny"}.`,
    );
  }
}

function assertAcceptedOwnerCommandOutcome(
  surface: R1OwnerSurface,
  result: R1BoundaryProbeResult,
): void {
  const accepted: readonly string[] =
    R1_OWNER_COMMAND_ACCEPTED_OUTCOMES[surface];
  if (result.outcome === undefined || !accepted.includes(result.outcome)) {
    throw new Error(
      `R1 owner command ${surface} returned unaccepted outcome: ${result.outcome ?? "MISSING"}.`,
    );
  }
}

function assertRaceEvidence(evidence: R1CommandRaceEvidence): void {
  if (
    evidence.idempotency.outcomes.length !== 2 ||
    evidence.idempotency.effectCount !== 1 ||
    evidence.idempotency.outcomes.filter((outcome) => outcome === "APPLIED")
      .length !== 1 ||
    evidence.idempotency.outcomes.some(
      (outcome) => outcome !== "APPLIED" && outcome !== "DEDUPLICATED",
    ) ||
    evidence.idempotency.retryOutcome !== "DEDUPLICATED"
  ) {
    throw new Error("R1 idempotent race did not produce exactly one effect.");
  }
  if (
    evidence.cas.outcomes.length !== 2 ||
    evidence.cas.effectCount !== 1 ||
    evidence.cas.outcomes.filter((outcome) => outcome === "APPLIED").length !==
      1 ||
    evidence.cas.outcomes.some(
      (outcome) => outcome !== "APPLIED" && outcome !== "STALE_REVISION",
    )
  ) {
    throw new Error("R1 CAS race did not reject every stale competing effect.");
  }
}

function assertMarkers(markers: readonly string[]): void {
  if (markers.length === 0 || markers.some((marker) => marker.length < 4)) {
    throw new TypeError("R1 matrix requires bounded private fixture markers.");
  }
}

function assertNoStore(response: TestHttpResponse): void {
  assertHeaderContains(response, "cache-control", "no-store");
}

function assertHeaderContains(
  response: TestHttpResponse,
  name: string,
  expected: string,
): void {
  const value = Object.entries(response.headers).find(
    ([candidate]) => candidate.toLowerCase() === name,
  )?.[1];
  if (value === undefined || !value.toLowerCase().includes(expected)) {
    throw new Error(`R1 response header ${name} is missing ${expected}.`);
  }
}

function required<Key, Value>(map: Map<Key, Value>, key: Key): Value {
  const value = map.get(key);
  if (value === undefined)
    throw new Error("R1 matrix adapter omitted evidence.");
  return value;
}
