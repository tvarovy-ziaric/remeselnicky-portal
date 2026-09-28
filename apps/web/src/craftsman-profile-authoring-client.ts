export type CraftsmanProfileType = "INDIVIDUAL" | "COMPANY";
export type DeclaredLevel = "BEGINNER" | "ADVANCED" | "MASTER";

interface ProfileBase {
  readonly about: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly identityVerified: boolean;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface IndividualProfile extends ProfileBase {
  readonly nickname: string | null;
  readonly profileType: "INDIVIDUAL";
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
}

export interface CompanyProfile extends ProfileBase {
  readonly companyRegistrationNumber: string | null;
  readonly companyRegistrationVerified: boolean;
  readonly officialCompanyName: string | null;
  readonly profileType: "COMPANY";
}

export type OwnedCraftsmanProfile = IndividualProfile | CompanyProfile;

export interface OwnedProfession {
  readonly createdAt: string;
  readonly declaredLevel: DeclaredLevel;
  readonly declaredLevelRevision: number;
  readonly deactivatedAt: string | null;
  readonly evidenceSupportedLevel: DeclaredLevel | null;
  readonly id: string;
  readonly professionCode: string;
  readonly state: "ACTIVE" | "INACTIVE";
}

export interface OwnedServiceArea {
  readonly baseMunicipalityCode: string | null;
  readonly createdAt: string;
  readonly extraMunicipalityCodes: readonly string[];
  readonly maximumRadiusKm: number | null;
  readonly normalRadiusKm: number | null;
  readonly revision: number;
  readonly travelFeePolicy: string | null;
  readonly travelFeeThresholdKm: number | null;
}

export type ReadinessRequirement =
  | "VALID_IDENTITY"
  | "ABOUT"
  | "ACTIVE_PROFESSION_WITH_DECLARED_LEVEL"
  | "BASE_MUNICIPALITY"
  | "NORMAL_RADIUS";

export interface OwnedPublication {
  readonly approvedAt: string | null;
  readonly changedAt: string | null;
  readonly effectivelyPublic: boolean;
  readonly moderationState: "ALLOWED" | "HIDDEN" | "RESTRICTED";
  readonly ownerVisibility: "HIDDEN" | "PUBLIC";
  readonly readiness: {
    readonly isReady: boolean;
    readonly missing: readonly ReadinessRequirement[];
  };
  readonly rejection: null | {
    readonly occurredAt: string;
    readonly reasonCode: string;
    readonly userFacingReason: string;
  };
  readonly reviewState: "APPROVED" | "DRAFT" | "PENDING" | "REJECTED";
  readonly revision: number;
}

export interface CraftsmanAuthoringAggregate {
  readonly profile: OwnedCraftsmanProfile;
  readonly professions: readonly OwnedProfession[];
  readonly publication: OwnedPublication | null;
  readonly serviceArea: OwnedServiceArea | null;
}

export type AuthoringLoadResult =
  | {
      readonly aggregate: CraftsmanAuthoringAggregate;
      readonly status: "READY";
    }
  | {
      readonly status:
        | "ACCOUNT_NOT_ACTIVE"
        | "AUTHENTICATION_REQUIRED"
        | "NOT_FOUND"
        | "UNAVAILABLE";
    };

export type AuthoringMutationResult = Readonly<{
  status:
    | "APPLIED"
    | "DENIED"
    | "INVALID_REQUEST"
    | "NOT_FOUND"
    | "NOT_READY"
    | "STALE_STATE"
    | "UNAVAILABLE";
}>;

export interface CraftsmanProfileAuthoringClient {
  assignProfession(input: {
    commandId: string;
    craftsmanProfessionId: string;
    declaredLevel: DeclaredLevel;
    professionCode: string;
    profileId: string;
  }): Promise<AuthoringMutationResult>;
  createProfile(
    input:
      | {
          about: string;
          nickname: string;
          profileType: "INDIVIDUAL";
          realFirstName: string;
          realLastName: string;
        }
      | {
          about: string;
          companyRegistrationNumber: string;
          officialCompanyName: string;
          profileType: "COMPANY";
        },
  ): Promise<AuthoringMutationResult>;
  load(): Promise<AuthoringLoadResult>;
  replaceProfile(
    input:
      | {
          about: string;
          expectedRevision: number;
          nickname: string;
          profileId: string;
          profileType: "INDIVIDUAL";
          realFirstName: string;
          realLastName: string;
        }
      | {
          about: string;
          companyRegistrationNumber: string;
          expectedRevision: number;
          officialCompanyName: string;
          profileId: string;
          profileType: "COMPANY";
        },
  ): Promise<AuthoringMutationResult>;
  replaceServiceArea(input: {
    baseMunicipalityCode: string;
    commandId: string;
    expectedRevision: number;
    normalRadiusKm: number;
    profileId: string;
  }): Promise<AuthoringMutationResult>;
  setVisibility(input: {
    commandId: string;
    expectedRevision: number;
    profileId: string;
    visibility: "HIDDEN" | "PUBLIC";
  }): Promise<AuthoringMutationResult>;
  submitForReview(input: {
    commandId: string;
    expectedRevision: number;
    profileId: string;
  }): Promise<AuthoringMutationResult>;
}

const basePath = "/v1/me/craftsman-profile";

export function createCraftsmanProfileAuthoringClient(
  fetcher: typeof fetch = fetch,
): CraftsmanProfileAuthoringClient {
  async function write(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    validSuccess: (value: unknown) => boolean,
  ) {
    try {
      const csrfToken = await loadCsrf(fetcher);
      if (csrfToken === null) return { status: "UNAVAILABLE" as const };
      const response = await fetcher(path, {
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        method,
      });
      if (response.ok)
        return validSuccess(await response.json())
          ? { status: "APPLIED" as const }
          : { status: "UNAVAILABLE" as const };
      return failure(response.status, await safeErrorCode(response));
    } catch {
      return { status: "UNAVAILABLE" as const };
    }
  }

  return Object.freeze({
    assignProfession(
      input: Parameters<CraftsmanProfileAuthoringClient["assignProfession"]>[0],
    ) {
      return write(
        basePath + "/" + encodeURIComponent(input.profileId) + "/professions",
        "POST",
        {
          commandId: input.commandId,
          craftsmanProfessionId: input.craftsmanProfessionId,
          declaredLevel: input.declaredLevel,
          professionCode: input.professionCode,
        },
        (value) =>
          entityCommandResponse(
            value,
            "profession",
            ["APPLIED", "DEDUPLICATED"],
            parseProfession,
          ),
      );
    },
    createProfile(
      input: Parameters<CraftsmanProfileAuthoringClient["createProfile"]>[0],
    ) {
      return write(
        basePath,
        "POST",
        input,
        (value) =>
          exactRecord(value, ["profile"]) &&
          parseProfile(value.profile) !== null,
      );
    },
    async load() {
      try {
        const response = await fetcher(basePath, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (response.status === 401)
          return { status: "AUTHENTICATION_REQUIRED" as const };
        if (response.status === 403)
          return { status: "ACCOUNT_NOT_ACTIVE" as const };
        if (response.status === 404) return { status: "NOT_FOUND" as const };
        const aggregate = parseCraftsmanAuthoringAggregate(
          await response.json(),
        );
        return response.ok && aggregate !== null
          ? { aggregate, status: "READY" as const }
          : { status: "UNAVAILABLE" as const };
      } catch {
        return { status: "UNAVAILABLE" as const };
      }
    },
    replaceProfile(
      input: Parameters<CraftsmanProfileAuthoringClient["replaceProfile"]>[0],
    ) {
      const { profileId, ...body } = input;
      return write(
        basePath + "/" + encodeURIComponent(profileId),
        "PUT",
        body,
        (value) =>
          entityCommandResponse(
            value,
            "profile",
            ["UPDATED", "UNCHANGED"],
            parseProfile,
          ),
      );
    },
    replaceServiceArea(
      input: Parameters<
        CraftsmanProfileAuthoringClient["replaceServiceArea"]
      >[0],
    ) {
      return write(
        basePath + "/" + encodeURIComponent(input.profileId) + "/service-area",
        "PUT",
        {
          baseMunicipalityCode: input.baseMunicipalityCode,
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          extraMunicipalityCodes: [],
          maximumRadiusKm: null,
          normalRadiusKm: input.normalRadiusKm,
          travelFeePolicy: null,
          travelFeeThresholdKm: null,
        },
        (value) =>
          entityCommandResponse(
            value,
            "serviceArea",
            ["APPLIED", "DEDUPLICATED", "UNCHANGED"],
            parseServiceArea,
          ),
      );
    },
    setVisibility(
      input: Parameters<CraftsmanProfileAuthoringClient["setVisibility"]>[0],
    ) {
      return write(
        basePath +
          "/" +
          encodeURIComponent(input.profileId) +
          "/publication/visibility",
        "POST",
        {
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          visibility: input.visibility,
        },
        (value) =>
          entityCommandResponse(
            value,
            "publication",
            ["APPLIED", "DEDUPLICATED", "UNCHANGED"],
            parsePublication,
          ),
      );
    },
    submitForReview(
      input: Parameters<CraftsmanProfileAuthoringClient["submitForReview"]>[0],
    ) {
      return write(
        basePath +
          "/" +
          encodeURIComponent(input.profileId) +
          "/publication/submit",
        "POST",
        {
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
        },
        (value) =>
          entityCommandResponse(
            value,
            "publication",
            ["APPLIED", "DEDUPLICATED"],
            parsePublication,
          ),
      );
    },
  });
}

export function parseCraftsmanAuthoringAggregate(
  value: unknown,
): CraftsmanAuthoringAggregate | null {
  if (
    !exactRecord(value, [
      "profile",
      "professions",
      "serviceArea",
      "publication",
    ])
  )
    return null;
  const profile = parseProfile(value.profile);
  if (
    profile === null ||
    !Array.isArray(value.professions) ||
    value.professions.length > 64
  )
    return null;
  const professions = value.professions.map(parseProfession);
  if (
    professions.some((profession) => profession === null) ||
    new Set(professions.map((profession) => profession?.id)).size !==
      professions.length
  )
    return null;
  const serviceArea =
    value.serviceArea === null ? null : parseServiceArea(value.serviceArea);
  const publication =
    value.publication === null ? null : parsePublication(value.publication);
  if (
    (value.serviceArea !== null && serviceArea === null) ||
    (value.publication !== null && publication === null)
  )
    return null;
  return Object.freeze({
    profile,
    professions: Object.freeze(professions as OwnedProfession[]),
    publication,
    serviceArea,
  });
}

function parseProfile(value: unknown): OwnedCraftsmanProfile | null {
  if (!record(value)) return null;
  const common =
    uuid(value.id) && (value.about === null || boundedText(value.about, 2_000));
  if (
    !common ||
    !positiveInteger(value.revision) ||
    !isoDate(value.createdAt) ||
    !isoDate(value.updatedAt) ||
    typeof value.identityVerified !== "boolean"
  )
    return null;
  if (
    value.profileType === "INDIVIDUAL" &&
    exactKeys(value, [
      "about",
      "createdAt",
      "id",
      "identityVerified",
      "nickname",
      "profileType",
      "realFirstName",
      "realLastName",
      "revision",
      "updatedAt",
    ]) &&
    nullableText(value.realFirstName) &&
    nullableText(value.realLastName) &&
    nullableText(value.nickname)
  )
    return Object.freeze(value) as unknown as IndividualProfile;
  if (
    value.profileType === "COMPANY" &&
    exactKeys(value, [
      "about",
      "companyRegistrationNumber",
      "companyRegistrationVerified",
      "createdAt",
      "id",
      "identityVerified",
      "officialCompanyName",
      "profileType",
      "revision",
      "updatedAt",
    ]) &&
    nullableText(value.officialCompanyName) &&
    nullableText(value.companyRegistrationNumber) &&
    typeof value.companyRegistrationVerified === "boolean"
  )
    return Object.freeze(value) as unknown as CompanyProfile;
  return null;
}

function parseProfession(value: unknown): OwnedProfession | null {
  if (
    !exactRecord(value, [
      "id",
      "professionCode",
      "state",
      "declaredLevel",
      "declaredLevelRevision",
      "evidenceSupportedLevel",
      "createdAt",
      "deactivatedAt",
    ]) ||
    !uuid(value.id) ||
    !professionCode(value.professionCode) ||
    !["ACTIVE", "INACTIVE"].includes(String(value.state)) ||
    !declaredLevel(value.declaredLevel) ||
    !positiveInteger(value.declaredLevelRevision) ||
    !(
      value.evidenceSupportedLevel === null ||
      declaredLevel(value.evidenceSupportedLevel)
    ) ||
    !isoDate(value.createdAt) ||
    !(value.deactivatedAt === null || isoDate(value.deactivatedAt))
  )
    return null;
  return Object.freeze(value) as unknown as OwnedProfession;
}

function parseServiceArea(value: unknown): OwnedServiceArea | null {
  if (
    !exactRecord(value, [
      "revision",
      "baseMunicipalityCode",
      "normalRadiusKm",
      "maximumRadiusKm",
      "extraMunicipalityCodes",
      "travelFeePolicy",
      "travelFeeThresholdKm",
      "createdAt",
    ]) ||
    !positiveInteger(value.revision) ||
    !(
      value.baseMunicipalityCode === null ||
      municipalityCode(value.baseMunicipalityCode)
    ) ||
    !nullableNonNegativeNumber(value.normalRadiusKm) ||
    !nullableNonNegativeNumber(value.maximumRadiusKm) ||
    !Array.isArray(value.extraMunicipalityCodes) ||
    value.extraMunicipalityCodes.length > 128 ||
    !value.extraMunicipalityCodes.every(municipalityCode) ||
    !nullableText(value.travelFeePolicy) ||
    !nullableNonNegativeNumber(value.travelFeeThresholdKm) ||
    !isoDate(value.createdAt)
  )
    return null;
  return Object.freeze({
    ...value,
    extraMunicipalityCodes: Object.freeze([...value.extraMunicipalityCodes]),
  }) as unknown as OwnedServiceArea;
}

function parsePublication(value: unknown): OwnedPublication | null {
  if (
    !exactRecord(value, [
      "revision",
      "reviewState",
      "ownerVisibility",
      "moderationState",
      "effectivelyPublic",
      "readiness",
      "approvedAt",
      "rejection",
      "changedAt",
    ]) ||
    !nonNegativeInteger(value.revision) ||
    !["DRAFT", "PENDING", "APPROVED", "REJECTED"].includes(
      String(value.reviewState),
    ) ||
    !["HIDDEN", "PUBLIC"].includes(String(value.ownerVisibility)) ||
    !["ALLOWED", "HIDDEN", "RESTRICTED"].includes(
      String(value.moderationState),
    ) ||
    typeof value.effectivelyPublic !== "boolean" ||
    !(value.approvedAt === null || isoDate(value.approvedAt)) ||
    !(value.changedAt === null || isoDate(value.changedAt)) ||
    !record(value.readiness) ||
    !exactKeys(value.readiness, ["isReady", "missing"]) ||
    typeof value.readiness.isReady !== "boolean" ||
    !Array.isArray(value.readiness.missing) ||
    value.readiness.missing.length > 5 ||
    !value.readiness.missing.every(readinessRequirement) ||
    new Set(value.readiness.missing).size !== value.readiness.missing.length ||
    value.readiness.isReady !== (value.readiness.missing.length === 0)
  )
    return null;
  if (
    value.rejection !== null &&
    (!exactRecord(value.rejection, [
      "reasonCode",
      "userFacingReason",
      "occurredAt",
    ]) ||
      !safeCode(value.rejection.reasonCode) ||
      !safeText(value.rejection.userFacingReason) ||
      !isoDate(value.rejection.occurredAt))
  )
    return null;
  return Object.freeze({
    ...value,
    readiness: Object.freeze({
      isReady: value.readiness.isReady,
      missing: Object.freeze([...value.readiness.missing]),
    }),
    rejection: value.rejection === null ? null : Object.freeze(value.rejection),
  }) as unknown as OwnedPublication;
}

function entityCommandResponse(
  value: unknown,
  entityKey: string,
  statuses: readonly string[],
  parseEntity: (entity: unknown) => object | null,
): boolean {
  return (
    exactRecord(value, ["status", entityKey]) &&
    statuses.includes(String(value.status)) &&
    parseEntity(value[entityKey]) !== null
  );
}

async function loadCsrf(fetcher: typeof fetch): Promise<string | null> {
  const response = await fetcher("/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return exactRecord(body, ["csrfToken"]) &&
    typeof body.csrfToken === "string" &&
    body.csrfToken.length >= 1 &&
    body.csrfToken.length <= 1_000 &&
    !/\p{Cc}/u.test(body.csrfToken)
    ? body.csrfToken
    : null;
}

async function safeErrorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    return record(body) && typeof body.code === "string" ? body.code : "";
  } catch {
    return "";
  }
}

function failure(status: number, code: string): AuthoringMutationResult {
  if (status === 400) return { status: "INVALID_REQUEST" };
  if (status === 401 || status === 403) return { status: "DENIED" };
  if (status === 404) return { status: "NOT_FOUND" };
  if (code === "NOT_READY") return { status: "NOT_READY" };
  if (status === 409) return { status: "STALE_STATE" };
  return { status: "UNAVAILABLE" };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return record(value) && exactKeys(value, keys);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function isoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 500 &&
    !/\p{Cc}/u.test(value)
  );
}
function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= max &&
    !/\p{Cc}/u.test(value.replaceAll("\n", ""))
  );
}
function nullableText(value: unknown): value is string | null {
  return value === null || safeText(value);
}
function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_.:-]{1,95}$/u.test(value);
}
function professionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}
function municipalityCode(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Z0-9][A-Z0-9._:-]{0,63}$/u.test(value)
  );
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function nullableNonNegativeNumber(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}
function declaredLevel(value: unknown): value is DeclaredLevel {
  return ["BEGINNER", "ADVANCED", "MASTER"].includes(String(value));
}
function readinessRequirement(value: unknown): value is ReadinessRequirement {
  return [
    "VALID_IDENTITY",
    "ABOUT",
    "ACTIVE_PROFESSION_WITH_DECLARED_LEVEL",
    "BASE_MUNICIPALITY",
    "NORMAL_RADIUS",
  ].includes(String(value));
}
