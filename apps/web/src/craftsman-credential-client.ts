export type CredentialEvidenceRequirement = "OPTIONAL" | "REQUIRED";
export type CredentialClaimState =
  "APPROVED" | "PENDING" | "REJECTED" | "REVOKED";
export type CredentialEvidenceMediaKind = "DOCUMENT" | "IMAGE";

export interface CredentialTypeOption {
  readonly code: string;
  readonly evidenceRequirement: CredentialEvidenceRequirement;
}

export interface CredentialEvidenceReference {
  readonly attachedAt: string;
  readonly mediaAssetId: string;
  readonly mediaKind: CredentialEvidenceMediaKind;
}

export interface OwnedCredentialClaim {
  readonly createdAt: string;
  readonly craftsmanProfessionId: string;
  readonly craftsmanProfileId: string;
  readonly credentialTypeCode: string;
  readonly evidence: readonly CredentialEvidenceReference[];
  readonly evidenceRequirement: CredentialEvidenceRequirement;
  readonly expiresOn: string | null;
  readonly id: string;
  readonly reviewReason: string | null;
  readonly reviewReasonCategory:
    | "EXPIRED_OR_INVALID"
    | "FALSE_IDENTITY"
    | "FALSE_QUALIFICATION"
    | "INSUFFICIENT_EVIDENCE"
    | "MISLEADING_CLAIM"
    | "OTHER"
    | null;
  readonly reviewedAt: string | null;
  readonly revision: number;
  readonly state: CredentialClaimState;
  readonly updatedAt: string;
}

export interface CredentialEvidenceUpload {
  readonly assetId: string;
  readonly kind: CredentialEvidenceMediaKind;
  readonly status: "PROCESSING" | "READY" | "REJECTED";
}

export type CredentialLoadResult<T> =
  | { readonly status: "READY"; readonly value: T }
  | {
      readonly status:
        "AUTHENTICATION_REQUIRED" | "DENIED" | "NOT_FOUND" | "UNAVAILABLE";
    };

export type CredentialMutationResult<T> =
  | { readonly status: "APPLIED"; readonly value: T }
  | {
      readonly status:
        | "CONFLICT"
        | "DENIED"
        | "INVALID_REQUEST"
        | "NOT_FOUND"
        | "STALE_STATE"
        | "UNAVAILABLE"
        | "WRONG_STATE";
    };

export interface CraftsmanCredentialClient {
  attachEvidence(input: {
    readonly claim: OwnedCredentialClaim;
    readonly profileId: string;
    readonly upload: CredentialEvidenceUpload;
  }): Promise<CredentialMutationResult<OwnedCredentialClaim>>;
  createClaim(input: {
    readonly craftsmanProfessionId: string;
    readonly credentialTypeCode: string;
    readonly expiresOn: string | null;
    readonly profileId: string;
  }): Promise<CredentialMutationResult<OwnedCredentialClaim>>;
  listEvidenceUploads(input: {
    readonly claimId: string;
    readonly profileId: string;
  }): Promise<CredentialLoadResult<readonly CredentialEvidenceUpload[]>>;
  load(profileId: string): Promise<
    CredentialLoadResult<{
      readonly credentials: readonly OwnedCredentialClaim[];
      readonly credentialTypes: readonly CredentialTypeOption[];
    }>
  >;
  uploadEvidence(input: {
    readonly claim: OwnedCredentialClaim;
    readonly file: File;
    readonly mediaKind: CredentialEvidenceMediaKind;
    readonly profileId: string;
  }): Promise<CredentialMutationResult<CredentialEvidenceUpload>>;
}

export function createCraftsmanCredentialClient(
  fetcher: typeof fetch = fetch,
  uuid: () => string = () => crypto.randomUUID(),
): CraftsmanCredentialClient {
  const createAttempts = new Map<
    string,
    { readonly claimId: string; readonly commandId: string }
  >();
  const attachAttempts = new Map<string, string>();
  const collectionPath = (profileId: string) =>
    `/v1/me/craftsman-profile/${encodeURIComponent(profileId)}/credentials`;
  const claimPath = (profileId: string, claimId: string) =>
    `${collectionPath(profileId)}/${encodeURIComponent(claimId)}`;

  return Object.freeze({
    async attachEvidence(
      input: Parameters<CraftsmanCredentialClient["attachEvidence"]>[0],
    ): Promise<CredentialMutationResult<OwnedCredentialClaim>> {
      if (
        input.claim.state !== "PENDING" ||
        input.upload.status !== "READY" ||
        !uuidValue(input.profileId) ||
        input.claim.craftsmanProfileId !== input.profileId ||
        !uuidValue(input.upload.assetId)
      ) {
        return { status: "WRONG_STATE" };
      }
      const key = JSON.stringify([
        input.profileId,
        input.claim.id,
        input.claim.revision,
        input.upload.assetId,
      ]);
      const commandId = attachAttempts.get(key) ?? uuid();
      attachAttempts.set(key, commandId);
      const result = await jsonMutation(
        fetcher,
        `${claimPath(input.profileId, input.claim.id)}/evidence`,
        {
          commandId,
          expectedRevision: input.claim.revision,
          mediaAssetId: input.upload.assetId,
        },
        (value) => parseClaimMutation(value, input.profileId),
      );
      if (result.definitive) attachAttempts.delete(key);
      return result.value;
    },

    async createClaim(
      input: Parameters<CraftsmanCredentialClient["createClaim"]>[0],
    ): Promise<CredentialMutationResult<OwnedCredentialClaim>> {
      if (
        !uuidValue(input.profileId) ||
        !uuidValue(input.craftsmanProfessionId) ||
        !credentialTypeCode(input.credentialTypeCode) ||
        (input.expiresOn !== null && !calendarDate(input.expiresOn))
      ) {
        return { status: "INVALID_REQUEST" };
      }
      const key = JSON.stringify(input);
      const attempt = createAttempts.get(key) ?? {
        claimId: uuid(),
        commandId: uuid(),
      };
      createAttempts.set(key, attempt);
      const result = await jsonMutation(
        fetcher,
        collectionPath(input.profileId),
        {
          ...attempt,
          craftsmanProfessionId: input.craftsmanProfessionId,
          credentialTypeCode: input.credentialTypeCode,
          expiresOn: input.expiresOn,
        },
        (value) => parseClaimMutation(value, input.profileId),
      );
      if (result.definitive) createAttempts.delete(key);
      return result.value;
    },

    listEvidenceUploads(
      input: Parameters<CraftsmanCredentialClient["listEvidenceUploads"]>[0],
    ): Promise<CredentialLoadResult<readonly CredentialEvidenceUpload[]>> {
      if (!uuidValue(input.profileId) || !uuidValue(input.claimId)) {
        return Promise.resolve({ status: "NOT_FOUND" });
      }
      return read(
        fetcher,
        `${claimPath(input.profileId, input.claimId)}/evidence-uploads`,
        parseUploadEnvelope,
      );
    },

    async load(
      profileId: string,
    ): ReturnType<CraftsmanCredentialClient["load"]> {
      if (!uuidValue(profileId)) return { status: "NOT_FOUND" };
      const root = `/v1/me/craftsman-profile/${encodeURIComponent(profileId)}`;
      const [types, claims] = await Promise.all([
        read(fetcher, `${root}/credential-types`, parseTypesEnvelope),
        read(fetcher, `${root}/credentials`, (value) =>
          parseClaimsEnvelope(value, profileId),
        ),
      ]);
      if (types.status !== "READY") return types;
      if (claims.status !== "READY") return claims;
      return {
        status: "READY",
        value: {
          credentials: claims.value,
          credentialTypes: types.value,
        },
      };
    },

    async uploadEvidence(
      input: Parameters<CraftsmanCredentialClient["uploadEvidence"]>[0],
    ): Promise<CredentialMutationResult<CredentialEvidenceUpload>> {
      const allowed =
        input.mediaKind === "DOCUMENT"
          ? input.file.type === "application/pdf"
          : ["image/heic", "image/heif", "image/jpeg", "image/png"].includes(
              input.file.type,
            );
      if (
        !allowed ||
        input.claim.state !== "PENDING" ||
        input.claim.craftsmanProfileId !== input.profileId
      ) {
        return { status: "INVALID_REQUEST" };
      }
      try {
        const csrf = await loadCsrf(fetcher);
        if (csrf === null) return { status: "UNAVAILABLE" };
        const segment = input.mediaKind === "DOCUMENT" ? "documents" : "photos";
        const response = await fetcher(
          `${claimPath(input.profileId, input.claim.id)}/evidence-uploads/${segment}`,
          {
            body: input.file,
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              accept: "application/json",
              "content-type": input.file.type,
              "x-csrf-token": csrf,
              "x-expected-credential-revision": String(input.claim.revision),
            },
            method: "POST",
          },
        );
        if (response.status !== 202) {
          return mutationFailure(
            response.status,
            await safeErrorCode(response),
          );
        }
        const parsed = parseUpload(await response.json());
        return parsed === null ||
          parsed.status !== "PROCESSING" ||
          parsed.kind !== input.mediaKind
          ? { status: "UNAVAILABLE" }
          : { status: "APPLIED", value: parsed };
      } catch {
        return { status: "UNAVAILABLE" };
      }
    },
  });
}

async function read<T>(
  fetcher: typeof fetch,
  path: string,
  parser: (value: unknown) => T | null,
): Promise<CredentialLoadResult<T>> {
  try {
    const response = await fetcher(path, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return loadFailure(response.status);
    const parsed = parser(await response.json());
    return parsed === null
      ? { status: "UNAVAILABLE" }
      : { status: "READY", value: parsed };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

async function jsonMutation<T>(
  fetcher: typeof fetch,
  path: string,
  body: object,
  parser: (value: unknown) => T | null,
): Promise<{
  readonly definitive: boolean;
  readonly value: CredentialMutationResult<T>;
}> {
  try {
    const csrf = await loadCsrf(fetcher);
    if (csrf === null)
      return { definitive: false, value: { status: "UNAVAILABLE" } };
    const response = await fetcher(path, {
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      method: "POST",
    });
    if (!response.ok) {
      return {
        definitive: response.status !== 503,
        value: mutationFailure(response.status, await safeErrorCode(response)),
      };
    }
    const parsed = parser(await response.json());
    return parsed === null
      ? { definitive: false, value: { status: "UNAVAILABLE" } }
      : { definitive: true, value: { status: "APPLIED", value: parsed } };
  } catch {
    return { definitive: false, value: { status: "UNAVAILABLE" } };
  }
}

async function loadCsrf(fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher("/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return exactRecord(value, ["csrfToken"]) &&
      typeof value.csrfToken === "string" &&
      value.csrfToken.length >= 16 &&
      value.csrfToken.length <= 512
      ? value.csrfToken
      : null;
  } catch {
    return null;
  }
}

function parseClaimMutation(
  value: unknown,
  expectedProfileId: string,
): OwnedCredentialClaim | null {
  if (!exactRecord(value, ["claim", "status"])) return null;
  if (value.status !== "APPLIED" && value.status !== "DEDUPLICATED")
    return null;
  return parseClaim(value.claim, expectedProfileId);
}

function parseTypesEnvelope(
  value: unknown,
): readonly CredentialTypeOption[] | null {
  if (
    !exactRecord(value, ["credentialTypes"]) ||
    !Array.isArray(value.credentialTypes)
  )
    return null;
  if (value.credentialTypes.length > 128) return null;
  const result = value.credentialTypes.map(parseType);
  if (result.some((item) => item === null)) return null;
  const codes = new Set(result.map((item) => item!.code));
  return codes.size === result.length
    ? (result as readonly CredentialTypeOption[])
    : null;
}

function parseClaimsEnvelope(
  value: unknown,
  profileId: string,
): readonly OwnedCredentialClaim[] | null {
  if (!exactRecord(value, ["credentials"]) || !Array.isArray(value.credentials))
    return null;
  const result = value.credentials.map((item) => parseClaim(item, profileId));
  if (result.some((item) => item === null)) return null;
  const ids = new Set(result.map((item) => item!.id));
  return ids.size === result.length
    ? (result as readonly OwnedCredentialClaim[])
    : null;
}

function parseUploadEnvelope(
  value: unknown,
): readonly CredentialEvidenceUpload[] | null {
  if (!exactRecord(value, ["uploads"]) || !Array.isArray(value.uploads))
    return null;
  if (value.uploads.length > 64) return null;
  const result = value.uploads.map(parseUpload);
  if (result.some((item) => item === null)) return null;
  const ids = new Set(result.map((item) => item!.assetId));
  return ids.size === result.length
    ? (result as readonly CredentialEvidenceUpload[])
    : null;
}

function parseType(value: unknown): CredentialTypeOption | null {
  if (!exactRecord(value, ["code", "evidenceRequirement"])) return null;
  return credentialTypeCode(value.code) &&
    (value.evidenceRequirement === "OPTIONAL" ||
      value.evidenceRequirement === "REQUIRED")
    ? (value as unknown as CredentialTypeOption)
    : null;
}

function parseClaim(
  value: unknown,
  expectedProfileId: string,
): OwnedCredentialClaim | null {
  const keys = [
    "createdAt",
    "craftsmanProfessionId",
    "craftsmanProfileId",
    "credentialTypeCode",
    "evidence",
    "evidenceRequirement",
    "expiresOn",
    "id",
    "reviewReason",
    "reviewReasonCategory",
    "reviewedAt",
    "revision",
    "state",
    "updatedAt",
  ];
  if (!exactRecord(value, keys) || !Array.isArray(value.evidence)) return null;
  if (
    value.craftsmanProfileId !== expectedProfileId ||
    !uuidValue(value.id) ||
    !uuidValue(value.craftsmanProfessionId) ||
    !credentialTypeCode(value.credentialTypeCode) ||
    !["APPROVED", "PENDING", "REJECTED", "REVOKED"].includes(
      String(value.state),
    ) ||
    !["OPTIONAL", "REQUIRED"].includes(String(value.evidenceRequirement)) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    (value.expiresOn !== null && !calendarDate(value.expiresOn)) ||
    !instant(value.createdAt) ||
    !instant(value.updatedAt) ||
    (value.reviewedAt !== null && !instant(value.reviewedAt)) ||
    (value.reviewReason !== null &&
      (typeof value.reviewReason !== "string" ||
        value.reviewReason.length > 500)) ||
    (value.reviewReasonCategory !== null &&
      (typeof value.reviewReasonCategory !== "string" ||
        ![
          "EXPIRED_OR_INVALID",
          "FALSE_IDENTITY",
          "FALSE_QUALIFICATION",
          "INSUFFICIENT_EVIDENCE",
          "MISLEADING_CLAIM",
          "OTHER",
        ].includes(value.reviewReasonCategory)))
  ) {
    return null;
  }
  const evidence = value.evidence.map(parseEvidence);
  if (evidence.some((item) => item === null)) return null;
  const ids = new Set(evidence.map((item) => item!.mediaAssetId));
  return ids.size === evidence.length
    ? ({ ...value, evidence } as unknown as OwnedCredentialClaim)
    : null;
}

function parseEvidence(value: unknown): CredentialEvidenceReference | null {
  if (!exactRecord(value, ["attachedAt", "mediaAssetId", "mediaKind"]))
    return null;
  return instant(value.attachedAt) &&
    uuidValue(value.mediaAssetId) &&
    (value.mediaKind === "DOCUMENT" || value.mediaKind === "IMAGE")
    ? (value as unknown as CredentialEvidenceReference)
    : null;
}

function parseUpload(value: unknown): CredentialEvidenceUpload | null {
  if (!exactRecord(value, ["assetId", "kind", "status"])) return null;
  return uuidValue(value.assetId) &&
    (value.kind === "DOCUMENT" || value.kind === "IMAGE") &&
    (value.status === "PROCESSING" ||
      value.status === "READY" ||
      value.status === "REJECTED")
    ? (value as unknown as CredentialEvidenceUpload)
    : null;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function uuidValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function credentialTypeCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
  );
}
function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function loadFailure(status: number): CredentialLoadResult<never> {
  if (status === 401) return { status: "AUTHENTICATION_REQUIRED" };
  if (status === 403) return { status: "DENIED" };
  if (status === 404) return { status: "NOT_FOUND" };
  return { status: "UNAVAILABLE" };
}

function mutationFailure(
  status: number,
  code: string | null,
): CredentialMutationResult<never> {
  if (status === 400) return { status: "INVALID_REQUEST" };
  if (status === 401 || status === 403) return { status: "DENIED" };
  if (status === 404) return { status: "NOT_FOUND" };
  if (status === 409 && code === "STALE_REVISION")
    return { status: "STALE_STATE" };
  if (status === 409 && code === "CLAIM_NOT_PENDING")
    return { status: "WRONG_STATE" };
  if (status === 409) return { status: "CONFLICT" };
  return { status: "UNAVAILABLE" };
}

async function safeErrorCode(response: Response): Promise<string | null> {
  try {
    const value: unknown = await response.json();
    return exactRecord(value, ["code"]) && typeof value.code === "string"
      ? value.code
      : null;
  } catch {
    return null;
  }
}
