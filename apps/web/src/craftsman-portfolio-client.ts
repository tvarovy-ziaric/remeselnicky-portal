export type PortfolioPhotoPhase = "AFTER" | "BEFORE" | "OTHER" | "PROGRESS";

export interface OwnedPortfolioProject {
  readonly contribution: string | null;
  readonly craftsmanProfileId: string;
  readonly createdAt: string;
  readonly districtCode: string | null;
  readonly durationUnit: "DAYS" | "MONTHS" | "WEEKS" | null;
  readonly durationValue: number | null;
  readonly evidenceStatus: "UNVERIFIED";
  readonly id: string;
  readonly indicativePriceMaxCents: number | null;
  readonly indicativePriceMinCents: number | null;
  readonly materialsAndTechnologies: string | null;
  readonly municipalityCode: string | null;
  readonly problem: string | null;
  readonly professionIds: readonly string[];
  readonly provenanceKind: "SELF_DECLARED";
  readonly recordState: "ARCHIVED" | "DRAFT" | "HIDDEN";
  readonly revision: number;
  readonly shortDescription: string;
  readonly skillIds: readonly string[];
  readonly solution: string | null;
  readonly specializationIds: readonly string[];
  readonly title: string;
  readonly updatedAt: string;
}

export interface OwnedPortfolioPhoto {
  readonly attachedAt: string;
  readonly attachmentId: string;
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly capturedAt: string | null;
  readonly downloadPath: string;
  readonly mediaAssetId: string;
  readonly order: number | null;
  readonly phase: PortfolioPhotoPhase;
  readonly state: "ACTIVE" | "HIDDEN";
}

export interface OwnedPortfolioPhotoSet {
  readonly craftsmanProfileId: string;
  readonly photos: readonly OwnedPortfolioPhoto[];
  readonly portfolioProjectId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface PortfolioPhotoUpload {
  readonly assetId: string;
  readonly kind: "IMAGE";
  readonly status: "PROCESSING" | "READY" | "REJECTED";
}

export type PortfolioLoadResult<T> =
  | { readonly status: "READY"; readonly value: T }
  | {
      readonly status:
        "AUTHENTICATION_REQUIRED" | "DENIED" | "NOT_FOUND" | "UNAVAILABLE";
    };

export type PortfolioMutationResult<T> =
  | { readonly status: "APPLIED"; readonly value: T }
  | {
      readonly status:
        | "DENIED"
        | "INVALID_REQUEST"
        | "NOT_FOUND"
        | "STALE_STATE"
        | "UNAVAILABLE";
    };

export interface CraftsmanPortfolioClient {
  attachPhoto(input: {
    readonly attachmentId: string;
    readonly commandId: string;
    readonly expectedRevision: number;
    readonly mediaAssetId: string;
    readonly phase: PortfolioPhotoPhase;
    readonly profileId: string;
    readonly projectId: string;
  }): Promise<PortfolioMutationResult<OwnedPortfolioPhotoSet>>;
  createProject(input: {
    readonly commandId: string;
    readonly contribution: string | null;
    readonly portfolioProjectId: string;
    readonly professionIds: readonly string[];
    readonly profileId: string;
    readonly shortDescription: string;
    readonly title: string;
  }): Promise<PortfolioMutationResult<OwnedPortfolioProject>>;
  editProject(input: {
    readonly commandId: string;
    readonly contribution: string | null;
    readonly expectedRevision: number;
    readonly professionIds: readonly string[];
    readonly profileId: string;
    readonly projectId: string;
    readonly shortDescription: string;
    readonly title: string;
  }): Promise<PortfolioMutationResult<OwnedPortfolioProject>>;
  listPhotos(
    profileId: string,
    projectId: string,
  ): Promise<PortfolioLoadResult<OwnedPortfolioPhotoSet>>;
  listProjects(
    profileId: string,
  ): Promise<PortfolioLoadResult<readonly OwnedPortfolioProject[]>>;
  listUploads(
    profileId: string,
    projectId: string,
  ): Promise<PortfolioLoadResult<readonly PortfolioPhotoUpload[]>>;
  uploadPhoto(input: {
    readonly file: File;
    readonly profileId: string;
    readonly projectId: string;
    readonly projectRevision: number;
  }): Promise<PortfolioMutationResult<PortfolioPhotoUpload>>;
}

export function createCraftsmanPortfolioClient(
  fetcher: typeof fetch = fetch,
): CraftsmanPortfolioClient {
  const collectionPath = (profileId: string) =>
    `/v1/me/craftsman-profile/${encodeURIComponent(profileId)}/portfolio-projects`;
  const projectPath = (profileId: string, projectId: string) =>
    `${collectionPath(profileId)}/${encodeURIComponent(projectId)}`;

  async function read<T>(
    path: string,
    parser: (value: unknown) => T | null,
  ): Promise<PortfolioLoadResult<T>> {
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

  async function writeJson<T>(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    parser: (value: unknown) => T | null,
  ): Promise<PortfolioMutationResult<T>> {
    try {
      const csrfToken = await loadCsrf(fetcher);
      if (csrfToken === null) return { status: "UNAVAILABLE" };
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
      if (!response.ok) return mutationFailure(response.status);
      const parsed = parser(await response.json());
      return parsed === null
        ? { status: "UNAVAILABLE" }
        : { status: "APPLIED", value: parsed };
    } catch {
      return { status: "UNAVAILABLE" };
    }
  }

  return Object.freeze({
    attachPhoto(input: Parameters<CraftsmanPortfolioClient["attachPhoto"]>[0]) {
      return writeJson(
        `${projectPath(input.profileId, input.projectId)}/photos`,
        "POST",
        {
          attachmentId: input.attachmentId,
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          mediaAssetId: input.mediaAssetId,
          phase: input.phase,
        },
        parsePhotoSetCommand,
      );
    },
    createProject(
      input: Parameters<CraftsmanPortfolioClient["createProject"]>[0],
    ) {
      return writeJson(
        collectionPath(input.profileId),
        "POST",
        {
          commandId: input.commandId,
          contribution: input.contribution,
          portfolioProjectId: input.portfolioProjectId,
          professionIds: input.professionIds,
          shortDescription: input.shortDescription,
          title: input.title,
        },
        parseProjectCommand,
      );
    },
    editProject(input: Parameters<CraftsmanPortfolioClient["editProject"]>[0]) {
      return writeJson(
        projectPath(input.profileId, input.projectId),
        "PUT",
        {
          commandId: input.commandId,
          contribution: input.contribution,
          expectedRevision: input.expectedRevision,
          professionIds: input.professionIds,
          shortDescription: input.shortDescription,
          title: input.title,
        },
        parseProjectCommand,
      );
    },
    listPhotos(profileId: string, projectId: string) {
      return read(
        `${projectPath(profileId, projectId)}/photos`,
        parsePhotoSetEnvelope,
      );
    },
    listProjects(profileId: string) {
      return read(collectionPath(profileId), parseProjectList);
    },
    listUploads(profileId: string, projectId: string) {
      return read(
        `${projectPath(profileId, projectId)}/photo-uploads`,
        parseUploadList,
      );
    },
    async uploadPhoto(
      input: Parameters<CraftsmanPortfolioClient["uploadPhoto"]>[0],
    ): Promise<PortfolioMutationResult<PortfolioPhotoUpload>> {
      try {
        const csrfToken = await loadCsrf(fetcher);
        if (csrfToken === null) return { status: "UNAVAILABLE" as const };
        const response = await fetcher(
          `${projectPath(input.profileId, input.projectId)}/photo-uploads`,
          {
            body: input.file,
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              accept: "application/json",
              "content-type": input.file.type,
              "x-csrf-token": csrfToken,
              "x-expected-project-revision": String(input.projectRevision),
            },
            method: "POST",
          },
        );
        if (!response.ok) return mutationFailure(response.status);
        const upload = parseUpload(await response.json());
        return upload === null || upload.status !== "PROCESSING"
          ? { status: "UNAVAILABLE" as const }
          : { status: "APPLIED" as const, value: upload };
      } catch {
        return { status: "UNAVAILABLE" as const };
      }
    },
  });
}

export function parseOwnedPortfolioProject(
  value: unknown,
): OwnedPortfolioProject | null {
  const keys = [
    "contribution",
    "craftsmanProfileId",
    "createdAt",
    "districtCode",
    "durationUnit",
    "durationValue",
    "evidenceStatus",
    "id",
    "indicativePriceMaxCents",
    "indicativePriceMinCents",
    "materialsAndTechnologies",
    "municipalityCode",
    "problem",
    "professionIds",
    "provenanceKind",
    "recordState",
    "revision",
    "shortDescription",
    "skillIds",
    "solution",
    "specializationIds",
    "title",
    "updatedAt",
  ] as const;
  if (!exactRecord(value, keys)) return null;
  if (
    !nullableString(value.contribution) ||
    !uuid(value.craftsmanProfileId) ||
    !isoDate(value.createdAt) ||
    !nullableString(value.districtCode) ||
    !oneOfOrNull(value.durationUnit, ["DAYS", "WEEKS", "MONTHS"]) ||
    !integerOrNull(value.durationValue) ||
    value.evidenceStatus !== "UNVERIFIED" ||
    !uuid(value.id) ||
    !integerOrNull(value.indicativePriceMaxCents) ||
    !integerOrNull(value.indicativePriceMinCents) ||
    !nullableString(value.materialsAndTechnologies) ||
    !nullableString(value.municipalityCode) ||
    !nullableString(value.problem) ||
    !uuidArray(value.professionIds) ||
    value.provenanceKind !== "SELF_DECLARED" ||
    !oneOf(value.recordState, ["DRAFT", "HIDDEN", "ARCHIVED"]) ||
    !positiveInteger(value.revision) ||
    !boundedString(value.shortDescription, 10, 600) ||
    !uuidArray(value.skillIds) ||
    !nullableString(value.solution) ||
    !uuidArray(value.specializationIds) ||
    !boundedString(value.title, 2, 120) ||
    !isoDate(value.updatedAt)
  ) {
    return null;
  }
  return value as unknown as OwnedPortfolioProject;
}

function parseProjectList(
  value: unknown,
): readonly OwnedPortfolioProject[] | null {
  if (!exactRecord(value, ["projects"]) || !Array.isArray(value.projects)) {
    return null;
  }
  const projects = value.projects.map(parseOwnedPortfolioProject);
  return projects.some((project) => project === null)
    ? null
    : (projects as readonly OwnedPortfolioProject[]);
}

function parseProjectCommand(value: unknown): OwnedPortfolioProject | null {
  if (
    !exactRecord(value, ["project", "status"]) ||
    !oneOf(value.status, ["APPLIED", "DEDUPLICATED"])
  ) {
    return null;
  }
  return parseOwnedPortfolioProject(value.project);
}

function parsePhotoSetEnvelope(value: unknown): OwnedPortfolioPhotoSet | null {
  return exactRecord(value, ["photoSet"])
    ? parsePhotoSet(value.photoSet)
    : null;
}

function parsePhotoSetCommand(value: unknown): OwnedPortfolioPhotoSet | null {
  if (
    !exactRecord(value, ["photoSet", "status"]) ||
    !oneOf(value.status, ["APPLIED", "DEDUPLICATED"])
  ) {
    return null;
  }
  return parsePhotoSet(value.photoSet);
}

function parsePhotoSet(value: unknown): OwnedPortfolioPhotoSet | null {
  if (
    !exactRecord(value, [
      "craftsmanProfileId",
      "photos",
      "portfolioProjectId",
      "revision",
      "updatedAt",
    ]) ||
    !uuid(value.craftsmanProfileId) ||
    !uuid(value.portfolioProjectId) ||
    !nonNegativeInteger(value.revision) ||
    !isoDate(value.updatedAt) ||
    !Array.isArray(value.photos)
  ) {
    return null;
  }
  const photos = value.photos.map(parsePhoto);
  return photos.some((photo) => photo === null)
    ? null
    : ({ ...value, photos } as unknown as OwnedPortfolioPhotoSet);
}

function parsePhoto(value: unknown): OwnedPortfolioPhoto | null {
  if (
    !exactRecord(value, [
      "attachedAt",
      "attachmentId",
      "canonicalHeight",
      "canonicalWidth",
      "capturedAt",
      "downloadPath",
      "mediaAssetId",
      "order",
      "phase",
      "state",
    ]) ||
    !isoDate(value.attachedAt) ||
    !uuid(value.attachmentId) ||
    !positiveInteger(value.canonicalHeight) ||
    !positiveInteger(value.canonicalWidth) ||
    !(value.capturedAt === null || isoDate(value.capturedAt)) ||
    !uuid(value.mediaAssetId) ||
    value.downloadPath !== `/v1/media/${value.mediaAssetId}/download` ||
    !(value.order === null || positiveInteger(value.order)) ||
    !oneOf(value.phase, ["BEFORE", "PROGRESS", "AFTER", "OTHER"]) ||
    !oneOf(value.state, ["ACTIVE", "HIDDEN"])
  ) {
    return null;
  }
  return value as unknown as OwnedPortfolioPhoto;
}

function parseUploadList(
  value: unknown,
): readonly PortfolioPhotoUpload[] | null {
  if (!exactRecord(value, ["uploads"]) || !Array.isArray(value.uploads)) {
    return null;
  }
  const uploads = value.uploads.map(parseUpload);
  return uploads.some((upload) => upload === null)
    ? null
    : (uploads as readonly PortfolioPhotoUpload[]);
}

function parseUpload(value: unknown): PortfolioPhotoUpload | null {
  return exactRecord(value, ["assetId", "kind", "status"]) &&
    uuid(value.assetId) &&
    value.kind === "IMAGE" &&
    oneOf(value.status, ["PROCESSING", "READY", "REJECTED"])
    ? (value as unknown as PortfolioPhotoUpload)
    : null;
}

async function loadCsrf(fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher("/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return exactRecord(body, ["csrfToken"]) &&
      boundedString(body.csrfToken, 1, 1_000) &&
      !/\p{Cc}/u.test(body.csrfToken)
      ? body.csrfToken
      : null;
  } catch {
    return null;
  }
}

function loadFailure(status: number): PortfolioLoadResult<never> {
  if (status === 401) return { status: "AUTHENTICATION_REQUIRED" };
  if (status === 403) return { status: "DENIED" };
  if (status === 404) return { status: "NOT_FOUND" };
  return { status: "UNAVAILABLE" };
}

function mutationFailure(status: number): PortfolioMutationResult<never> {
  if (status === 400 || status === 413) return { status: "INVALID_REQUEST" };
  if (status === 401 || status === 403) return { status: "DENIED" };
  if (status === 404) return { status: "NOT_FOUND" };
  if (status === 409) return { status: "STALE_STATE" };
  return { status: "UNAVAILABLE" };
}

function exactRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function uuidArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(uuid) &&
    new Set(value).size === value.length
  );
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function integerOrNull(value: unknown): value is number | null {
  return (
    value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
  );
}

function isoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 35 &&
    Number.isFinite(Date.parse(value))
  );
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.some((item) => item === value);
}

function oneOfOrNull<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T | null {
  return value === null || oneOf(value, allowed);
}
