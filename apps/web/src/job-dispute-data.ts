const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const privateDownload =
  /^\/v1\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/download$/iu;
const eventType = /^[A-Z][A-Z0-9_]{0,79}$/u;
const control = /[\p{Cc}]/u;

type Dict = Record<string, unknown>;

export const jobDisputeCategories = Object.freeze([
  ["UNFINISHED_WORK", "Nedokončená práca"],
  ["QUALITY_DEFECT", "Kvalita alebo vada"],
  ["SCOPE", "Rozsah práce"],
  ["PRICE_CHANGE_ORDER", "Cena alebo schválená zmena"],
  ["SCHEDULE", "Termín"],
  ["MATERIAL", "Materiál"],
  ["DOCUMENTS", "Dokumenty"],
  ["CANCELLATION", "Zrušenie zákazky"],
  ["COMMUNICATION_BEHAVIOR", "Komunikácia alebo správanie"],
  ["OTHER", "Iné"],
] as const);

export type JobDisputeCategory = (typeof jobDisputeCategories)[number][0];
export type JobDisputePartyRole = "CUSTOMER" | "PRIMARY_PROVIDER";
export type JobDisputeState =
  "OPEN" | "WAITING_FOR_PARTY" | "UNDER_REVIEW" | "RESOLVED" | "CLOSED";

export interface JobDisputeSummary {
  readonly id: string;
  readonly jobId: string;
  readonly openedByRole: JobDisputePartyRole;
  readonly viewerRole: JobDisputePartyRole;
  readonly category: JobDisputeCategory;
  readonly description: string;
  readonly desiredResolution: string;
  readonly state: JobDisputeState;
  readonly stateRevision: number;
  readonly createdAt: string;
  readonly stateChangedAt: string;
  readonly canAddContent: boolean;
}

export interface JobDisputeStatement {
  readonly id: string;
  readonly authorRole: JobDisputePartyRole;
  readonly kind: "STATEMENT" | "ADDENDUM";
  readonly body: string;
  readonly createdAt: string;
}

export interface JobDisputeEvidence {
  readonly id: string;
  readonly submittedByRole: JobDisputePartyRole;
  readonly source: "NEW_UPLOAD" | "EXISTING_JOB_EVIDENCE";
  readonly mediaAssetId: string;
  readonly kind: "PHOTO" | "DOCUMENT";
  readonly description: string;
  readonly displayFilename: string | null;
  readonly contentType: string;
  readonly downloadPath: string;
  readonly createdAt: string;
}

export interface JobDisputeDetail extends JobDisputeSummary {
  readonly statements: readonly JobDisputeStatement[];
  readonly evidence: readonly JobDisputeEvidence[];
  readonly commercialBaseline: Readonly<{
    acceptedRequestContentRevision: number;
    acceptedRequestVisibleVersion: number;
    acceptedQuoteId: string;
    acceptedQuoteRevision: number;
    acceptedQuoteMode: "PLATFORM_STRUCTURED" | "EXTERNAL_PDF";
    acceptedQuotePdfDownloadPath: string | null;
    approvedChanges: readonly Readonly<{
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
      title: string;
      changeDescription: string;
      approvedAt: string;
    }>[];
    jobDashboardPath: string;
  }>;
  readonly jobTimeline: readonly Readonly<{
    eventId: string;
    eventType: string;
    occurredAt: string;
  }>[];
}

export type JobDisputeLoad<T> =
  | { readonly status: "OK"; readonly value: T }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

export type JobDisputeCommandResult =
  | {
      readonly status: "OK";
      readonly outcome: "APPLIED" | "DEDUPLICATED";
      readonly id: string;
      readonly disputeId: string;
      readonly occurredAt: string;
    }
  | {
      readonly status:
        | "AUTH_REQUIRED"
        | "NOT_FOUND"
        | "CASE_CLOSED"
        | "DUPLICATE_EVIDENCE"
        | "CONFLICT"
        | "UNAVAILABLE";
    };

export type JobDisputeUploadResult =
  | {
      readonly status: "OK";
      readonly assetId: string;
      readonly kind: "IMAGE" | "PDF";
    }
  | {
      readonly status:
        | "AUTH_REQUIRED"
        | "NOT_FOUND"
        | "INVALID_FILE"
        | "FILE_TOO_LARGE"
        | "UNAVAILABLE";
    };

export interface JobDisputeUploadStatus {
  readonly status: "PROCESSING" | "READY" | "REJECTED";
  readonly canBind: boolean;
}

const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Dict, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const text = (value: unknown, minimum: number, maximum: number) =>
  typeof value === "string" &&
  value.length >= minimum &&
  value.length <= maximum &&
  value === value.trim() &&
  !control.test(value);
const positiveRevision = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) > 0;
const role = (value: unknown): value is JobDisputePartyRole =>
  value === "CUSTOMER" || value === "PRIMARY_PROVIDER";
const category = (value: unknown): value is JobDisputeCategory =>
  jobDisputeCategories.some(([candidate]) => candidate === value);
const state = (value: unknown): value is JobDisputeState =>
  ["OPEN", "WAITING_FOR_PARTY", "UNDER_REVIEW", "RESOLVED", "CLOSED"].includes(
    String(value),
  );

function parseSummary(value: unknown, jobId: string): JobDisputeSummary | null {
  if (
    !record(value) ||
    !exact(value, [
      "id",
      "jobId",
      "openedByRole",
      "viewerRole",
      "category",
      "description",
      "desiredResolution",
      "state",
      "stateRevision",
      "createdAt",
      "stateChangedAt",
      "canAddContent",
    ]) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    value.jobId !== jobId ||
    !role(value.openedByRole) ||
    !role(value.viewerRole) ||
    !category(value.category) ||
    !text(value.description, 10, 4_000) ||
    !text(value.desiredResolution, 1, 2_000) ||
    !state(value.state) ||
    !positiveRevision(value.stateRevision) ||
    !instant(value.createdAt) ||
    !instant(value.stateChangedAt) ||
    Date.parse(value.stateChangedAt) < Date.parse(value.createdAt) ||
    typeof value.canAddContent !== "boolean" ||
    value.canAddContent !== !["RESOLVED", "CLOSED"].includes(value.state)
  )
    return null;
  return value as unknown as JobDisputeSummary;
}

export function parseJobDisputeList(
  value: unknown,
  jobId: string,
): readonly JobDisputeSummary[] | null {
  if (
    !uuid.test(jobId) ||
    !record(value) ||
    !exact(value, ["items"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 1_000
  )
    return null;
  const parsed = value.items.map((item) => parseSummary(item, jobId));
  if (parsed.some((item) => item === null)) return null;
  const items = parsed as JobDisputeSummary[];
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) return null;
  return Object.freeze(items);
}

function parseStatement(value: unknown): JobDisputeStatement | null {
  if (
    !record(value) ||
    !exact(value, ["id", "authorRole", "kind", "body", "createdAt"]) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    !role(value.authorRole) ||
    (value.kind !== "STATEMENT" && value.kind !== "ADDENDUM") ||
    !text(value.body, 1, 4_000) ||
    !instant(value.createdAt)
  )
    return null;
  return value as unknown as JobDisputeStatement;
}

function parseEvidence(value: unknown): JobDisputeEvidence | null {
  if (
    !record(value) ||
    !exact(value, [
      "id",
      "submittedByRole",
      "source",
      "mediaAssetId",
      "kind",
      "description",
      "displayFilename",
      "contentType",
      "downloadPath",
      "createdAt",
    ]) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    !role(value.submittedByRole) ||
    !["NEW_UPLOAD", "EXISTING_JOB_EVIDENCE"].includes(String(value.source)) ||
    typeof value.mediaAssetId !== "string" ||
    !uuid.test(value.mediaAssetId) ||
    (value.kind !== "PHOTO" && value.kind !== "DOCUMENT") ||
    !text(value.description, 1, 1_000) ||
    (value.displayFilename !== null && !text(value.displayFilename, 1, 255)) ||
    typeof value.contentType !== "string" ||
    (value.kind === "PHOTO" && value.contentType !== "image/webp") ||
    (value.kind === "DOCUMENT" && value.contentType !== "application/pdf") ||
    typeof value.downloadPath !== "string" ||
    privateDownload.exec(value.downloadPath)?.[1]?.toLowerCase() !==
      value.mediaAssetId.toLowerCase() ||
    !instant(value.createdAt)
  )
    return null;
  return value as unknown as JobDisputeEvidence;
}

function parseBaseline(value: unknown, jobId: string) {
  if (
    !record(value) ||
    !exact(value, [
      "acceptedRequestContentRevision",
      "acceptedRequestVisibleVersion",
      "acceptedQuoteId",
      "acceptedQuoteRevision",
      "acceptedQuoteMode",
      "acceptedQuotePdfDownloadPath",
      "approvedChanges",
      "jobDashboardPath",
    ]) ||
    !positiveRevision(value.acceptedRequestContentRevision) ||
    !positiveRevision(value.acceptedRequestVisibleVersion) ||
    typeof value.acceptedQuoteId !== "string" ||
    !uuid.test(value.acceptedQuoteId) ||
    !positiveRevision(value.acceptedQuoteRevision) ||
    !["PLATFORM_STRUCTURED", "EXTERNAL_PDF"].includes(
      String(value.acceptedQuoteMode),
    ) ||
    (value.acceptedQuotePdfDownloadPath !== null &&
      (typeof value.acceptedQuotePdfDownloadPath !== "string" ||
        !privateDownload.test(value.acceptedQuotePdfDownloadPath))) ||
    !Array.isArray(value.approvedChanges) ||
    value.approvedChanges.length > 1_000 ||
    value.jobDashboardPath !== `/zakazky/${jobId}`
  )
    return null;
  const changes = value.approvedChanges;
  for (const change of changes) {
    if (
      !record(change) ||
      !exact(change, [
        "changeOrderId",
        "revisionId",
        "revisionNumber",
        "title",
        "changeDescription",
        "approvedAt",
      ]) ||
      typeof change.changeOrderId !== "string" ||
      !uuid.test(change.changeOrderId) ||
      typeof change.revisionId !== "string" ||
      !uuid.test(change.revisionId) ||
      !positiveRevision(change.revisionNumber) ||
      !text(change.title, 1, 200) ||
      !text(change.changeDescription, 1, 4_000) ||
      !instant(change.approvedAt)
    )
      return null;
  }
  return value as unknown as JobDisputeDetail["commercialBaseline"];
}

export function parseJobDisputeDetail(
  value: unknown,
  jobId: string,
  disputeId: string,
): JobDisputeDetail | null {
  if (!record(value) || !uuid.test(disputeId) || value.id !== disputeId)
    return null;
  const summaryValue = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        ![
          "statements",
          "evidence",
          "commercialBaseline",
          "jobTimeline",
        ].includes(key),
    ),
  );
  const summary = parseSummary(summaryValue, jobId);
  if (
    summary === null ||
    !Array.isArray(value.statements) ||
    value.statements.length > 5_000 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 5_000 ||
    !Array.isArray(value.jobTimeline) ||
    value.jobTimeline.length > 10_000
  )
    return null;
  const statements = value.statements.map(parseStatement);
  const evidence = value.evidence.map(parseEvidence);
  const baseline = parseBaseline(value.commercialBaseline, jobId);
  if (
    statements.some((item) => item === null) ||
    evidence.some((item) => item === null) ||
    baseline === null
  )
    return null;
  for (const item of value.jobTimeline) {
    if (
      !record(item) ||
      !exact(item, ["eventId", "eventType", "occurredAt"]) ||
      typeof item.eventId !== "string" ||
      !uuid.test(item.eventId) ||
      typeof item.eventType !== "string" ||
      !eventType.test(item.eventType) ||
      !instant(item.occurredAt)
    )
      return null;
  }
  const statementIds = new Set(
    (statements as JobDisputeStatement[]).map((item) => item.id),
  );
  const evidenceIds = new Set(
    (evidence as JobDisputeEvidence[]).map((item) => item.id),
  );
  if (
    statementIds.size !== statements.length ||
    evidenceIds.size !== evidence.length
  )
    return null;
  return Object.freeze({
    ...summary,
    statements: Object.freeze(statements as JobDisputeStatement[]),
    evidence: Object.freeze(evidence as JobDisputeEvidence[]),
    commercialBaseline: baseline,
    jobTimeline: Object.freeze(
      value.jobTimeline as JobDisputeDetail["jobTimeline"],
    ),
  });
}

export function createJobDisputeCommandId(): string {
  return crypto.randomUUID();
}

export async function loadJobDisputes(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
}): Promise<JobDisputeLoad<readonly JobDisputeSummary[]>> {
  return load(
    input.fetch,
    input.jobId,
    `/v1/me/jobs/${input.jobId}/disputes`,
    (value) => parseJobDisputeList(value, input.jobId),
  );
}

export async function loadJobDispute(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly disputeId: string;
}): Promise<JobDisputeLoad<JobDisputeDetail>> {
  if (!uuid.test(input.disputeId)) return { status: "UNAVAILABLE" };
  return load(
    input.fetch,
    input.jobId,
    `/v1/me/jobs/${input.jobId}/disputes/${input.disputeId}`,
    (value) => parseJobDisputeDetail(value, input.jobId, input.disputeId),
  );
}

export async function openJobDispute(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly commandId: string;
  readonly category: JobDisputeCategory;
  readonly description: string;
  readonly desiredResolution: string;
}): Promise<JobDisputeCommandResult> {
  if (
    !category(input.category) ||
    !text(input.description.trim(), 10, 4_000) ||
    !text(input.desiredResolution.trim(), 1, 2_000)
  )
    return { status: "UNAVAILABLE" };
  return command(input.fetch, input.jobId, input.commandId, "disputes", {
    category: input.category,
    description: input.description.trim(),
    desiredResolution: input.desiredResolution.trim(),
  });
}

export async function addJobDisputeStatement(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly disputeId: string;
  readonly commandId: string;
  readonly kind: "STATEMENT" | "ADDENDUM";
  readonly body: string;
}): Promise<JobDisputeCommandResult> {
  if (
    !uuid.test(input.disputeId) ||
    !["STATEMENT", "ADDENDUM"].includes(input.kind) ||
    !text(input.body.trim(), 1, 4_000)
  )
    return { status: "UNAVAILABLE" };
  return command(
    input.fetch,
    input.jobId,
    input.commandId,
    `disputes/${input.disputeId}/statements`,
    { kind: input.kind, body: input.body.trim() },
  );
}

export async function addJobDisputeEvidence(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly disputeId: string;
  readonly commandId: string;
  readonly source: "NEW_UPLOAD" | "EXISTING_JOB_EVIDENCE";
  readonly mediaAssetId: string;
  readonly description: string;
}): Promise<JobDisputeCommandResult> {
  if (
    !uuid.test(input.disputeId) ||
    !uuid.test(input.mediaAssetId) ||
    !["NEW_UPLOAD", "EXISTING_JOB_EVIDENCE"].includes(input.source) ||
    !text(input.description.trim(), 1, 1_000)
  )
    return { status: "UNAVAILABLE" };
  return command(
    input.fetch,
    input.jobId,
    input.commandId,
    `disputes/${input.disputeId}/evidence`,
    {
      source: input.source,
      mediaAssetId: input.mediaAssetId,
      description: input.description.trim(),
    },
  );
}

export async function uploadJobDisputeEvidence(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly disputeId: string;
  readonly file: File;
}): Promise<JobDisputeUploadResult> {
  const isPdf = input.file.type === "application/pdf";
  const isImage = [
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
  ].includes(input.file.type);
  const maximum = isPdf ? 25 * 1024 * 1024 : 15 * 1024 * 1024;
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.disputeId) ||
    (!isPdf && !isImage) ||
    input.file.size < 1 ||
    input.file.size > maximum
  )
    return {
      status: input.file.size > maximum ? "FILE_TOO_LARGE" : "INVALID_FILE",
    };
  try {
    const csrfResult = await csrf(input.fetch);
    if (csrfResult?.status === "AUTH_REQUIRED")
      return { status: "AUTH_REQUIRED" };
    if (csrfResult === null) return { status: "UNAVAILABLE" };
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/disputes/${input.disputeId}/evidence/uploads/${isPdf ? "documents" : "photos"}`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": input.file.type,
          "x-csrf-token": csrfResult.token,
        },
        body: input.file,
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 400) return { status: "INVALID_FILE" };
    if (response.status === 413) return { status: "FILE_TOO_LARGE" };
    if (response.status !== 202) return { status: "UNAVAILABLE" };
    const value: unknown = await response.json();
    if (
      !record(value) ||
      !exact(value, ["assetId", "kind", "status"]) ||
      typeof value.assetId !== "string" ||
      !uuid.test(value.assetId) ||
      value.kind !== (isPdf ? "PDF" : "IMAGE") ||
      value.status !== "PROCESSING"
    )
      return { status: "UNAVAILABLE" };
    return {
      status: "OK",
      assetId: value.assetId,
      kind: isPdf ? "PDF" : "IMAGE",
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function loadJobDisputeUploadStatus(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly disputeId: string;
  readonly mediaAssetId: string;
}): Promise<JobDisputeLoad<JobDisputeUploadStatus>> {
  if (!uuid.test(input.disputeId) || !uuid.test(input.mediaAssetId))
    return { status: "UNAVAILABLE" };
  return load(
    input.fetch,
    input.jobId,
    `/v1/me/jobs/${input.jobId}/disputes/${input.disputeId}/evidence/uploads/${input.mediaAssetId}/status`,
    (value) => {
      if (
        !record(value) ||
        !exact(value, ["status", "canBind"]) ||
        !["PROCESSING", "READY", "REJECTED"].includes(String(value.status)) ||
        typeof value.canBind !== "boolean" ||
        (value.status === "PROCESSING" && value.canBind)
      )
        return null;
      return value as unknown as JobDisputeUploadStatus;
    },
  );
}

async function load<T>(
  fetcher: typeof fetch,
  jobId: string,
  path: string,
  parse: (value: unknown) => T | null,
): Promise<JobDisputeLoad<T>> {
  if (!uuid.test(jobId)) return { status: "UNAVAILABLE" };
  try {
    const response = await fetcher.call(globalThis, path, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const parsed = parse(await response.json());
    return parsed === null
      ? { status: "UNAVAILABLE" }
      : { status: "OK", value: parsed };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

async function command(
  fetcher: typeof fetch,
  jobId: string,
  commandId: string,
  suffix: string,
  body: Dict,
): Promise<JobDisputeCommandResult> {
  if (!uuid.test(jobId) || !uuid.test(commandId))
    return { status: "UNAVAILABLE" };
  try {
    const csrfResult = await csrf(fetcher);
    if (csrfResult?.status === "AUTH_REQUIRED")
      return { status: "AUTH_REQUIRED" };
    if (csrfResult === null) return { status: "UNAVAILABLE" };
    const response = await fetcher.call(
      globalThis,
      `/v1/me/jobs/${jobId}/${suffix}`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrfResult.token,
        },
        body: JSON.stringify({ commandId, ...body }),
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) {
      const value: unknown = await response.json();
      if (!record(value) || !exact(value, ["code"]))
        return { status: "UNAVAILABLE" };
      if (value.code === "CASE_CLOSED") return { status: "CASE_CLOSED" };
      if (value.code === "DUPLICATE_EVIDENCE")
        return { status: "DUPLICATE_EVIDENCE" };
      if (value.code === "IDEMPOTENCY_CONFLICT") return { status: "CONFLICT" };
      return { status: "UNAVAILABLE" };
    }
    if (!response.ok) return { status: "UNAVAILABLE" };
    const value: unknown = await response.json();
    if (
      !record(value) ||
      !exact(value, ["status", "id", "disputeId", "occurredAt"]) ||
      (value.status !== "APPLIED" && value.status !== "DEDUPLICATED") ||
      typeof value.id !== "string" ||
      !uuid.test(value.id) ||
      typeof value.disputeId !== "string" ||
      !uuid.test(value.disputeId) ||
      !instant(value.occurredAt)
    )
      return { status: "UNAVAILABLE" };
    return {
      status: "OK",
      outcome: value.status,
      id: value.id,
      disputeId: value.disputeId,
      occurredAt: value.occurredAt,
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

async function csrf(
  fetcher: typeof fetch,
): Promise<
  | { readonly status: "OK"; readonly token: string }
  | { readonly status: "AUTH_REQUIRED" }
  | null
> {
  const response = await fetcher.call(globalThis, "/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401) return { status: "AUTH_REQUIRED" };
  if (!response.ok) return null;
  const value: unknown = await response.json();
  return record(value) &&
    exact(value, ["csrfToken"]) &&
    typeof value.csrfToken === "string" &&
    value.csrfToken.length >= 1 &&
    value.csrfToken.length <= 1_000 &&
    !control.test(value.csrfToken)
    ? { status: "OK", token: value.csrfToken }
    : null;
}
