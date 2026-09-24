export const ADMIN_DISPUTE_STATES = Object.freeze([
  "OPEN",
  "WAITING_FOR_PARTY",
  "UNDER_REVIEW",
  "RESOLVED",
  "CLOSED",
] as const);

export type AdminDisputeState = (typeof ADMIN_DISPUTE_STATES)[number];

export interface AdminDisputeQueueItem {
  readonly disputeId: string;
  readonly jobId: string;
  readonly category: string;
  readonly state: AdminDisputeState;
  readonly openedByRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly createdAt: string;
  readonly stateChangedAt: string;
  readonly informationRequestCount: number;
}

export interface AdminDisputeDetail extends AdminDisputeQueueItem {
  readonly description: string;
  readonly desiredResolution: string;
  readonly jobState: string;
  readonly conversationId: string;
  readonly statements: readonly Readonly<{
    id: string;
    authorRole: string;
    kind: string;
    body: string;
    createdAt: string;
  }>[];
  readonly evidence: readonly Readonly<{
    id: string;
    submittedByRole: string;
    mediaAssetId: string;
    description: string;
    createdAt: string;
  }>[];
  readonly informationRequests: readonly Readonly<{
    id: string;
    recipient: "CUSTOMER" | "PRIMARY_PROVIDER" | "BOTH";
    requestText: string;
    replyDeadline: string | null;
    requestedAt: string;
  }>[];
  readonly internalNotes: readonly Readonly<{
    id: string;
    body: string;
    createdAt: string;
  }>[];
  readonly outcomes: readonly Readonly<{
    id: string;
    category: string;
    basis: "MUTUAL_PARTY_AGREEMENT" | "ADMINISTRATIVE_CLOSURE";
    summary: string;
    recordedAt: string;
  }>[];
  readonly conversation: readonly Readonly<{
    id: string;
    sequence: number;
    kind: string;
    authorUserId: string | null;
    body: string | null;
    createdAt: string;
  }>[];
  readonly attachments: readonly Readonly<{
    mediaAssetId: string;
    sourceMessageId: string;
    mediaKind: string;
    uploadedAt: string;
  }>[];
}

export type AdminReadResult<T> =
  | Readonly<{ status: "OK"; value: T }>
  | Readonly<{
      status: "AUTH_REQUIRED" | "ACCESS_DENIED" | "NOT_FOUND" | "UNAVAILABLE";
    }>;

export type AdminCommandResult =
  | Readonly<{
      status: "OK";
      outcome: "APPLIED" | "DEDUPLICATED";
      commandId: string;
      state: string;
      recordedAt: string;
    }>
  | Readonly<{
      status:
        | "AUTH_REQUIRED"
        | "ACCESS_DENIED"
        | "NOT_FOUND"
        | "STALE_STATE"
        | "CONFLICT"
        | "UNAVAILABLE";
    }>;

type Fetcher = typeof fetch;
type Dict = Record<string, unknown>;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const stateSet = new Set<string>(ADMIN_DISPUTE_STATES);
const queueKeys = [
  "disputeId",
  "jobId",
  "category",
  "state",
  "openedByRole",
  "createdAt",
  "stateChangedAt",
  "informationRequestCount",
] as const;

export function createAdminCommandId(): string {
  return crypto.randomUUID();
}

export function parseAdminDisputeQueue(
  value: unknown,
): readonly AdminDisputeQueueItem[] | null {
  if (!record(value) || !exact(value, ["items"]) || !Array.isArray(value.items))
    return null;
  const items = value.items.map((item) => parseQueueItem(item, false));
  if (items.length > 100 || items.some((item) => item === null)) return null;
  const typed = items as AdminDisputeQueueItem[];
  if (new Set(typed.map(({ disputeId }) => disputeId)).size !== typed.length)
    return null;
  return Object.freeze(typed.map((item) => Object.freeze(item)));
}

export function parseAdminDisputeDetail(
  value: unknown,
): AdminDisputeDetail | null {
  if (!record(value) || !exact(value, ["detail"]) || !record(value.detail))
    return null;
  const detail = value.detail;
  if (
    !exact(detail, [
      "disputeId",
      "jobId",
      "category",
      "state",
      "openedByRole",
      "createdAt",
      "stateChangedAt",
      "informationRequestCount",
      "description",
      "desiredResolution",
      "jobState",
      "conversationId",
      "statements",
      "evidence",
      "informationRequests",
      "internalNotes",
      "outcomes",
      "conversation",
      "attachments",
    ]) ||
    parseQueueItem(detail, true) === null ||
    !bounded(detail.description, 1, 10_000) ||
    !bounded(detail.desiredResolution, 1, 4_000) ||
    !bounded(detail.jobState, 1, 80) ||
    !id(detail.conversationId)
  )
    return null;
  const statements = parseArray(detail.statements, parseStatement, 2_000);
  const evidence = parseArray(detail.evidence, parseEvidence, 2_000);
  const informationRequests = parseArray(
    detail.informationRequests,
    parseInformationRequest,
    1_000,
  );
  const internalNotes = parseArray(
    detail.internalNotes,
    parseInternalNote,
    2_000,
  );
  const outcomes = parseArray(detail.outcomes, parseOutcome, 1_000);
  const conversation = parseArray(
    detail.conversation,
    parseConversationEntry,
    10_000,
  );
  const attachments = parseArray(detail.attachments, parseAttachment, 5_000);
  if (
    statements === null ||
    evidence === null ||
    informationRequests === null ||
    internalNotes === null ||
    outcomes === null ||
    conversation === null ||
    attachments === null ||
    informationRequests.length !== detail.informationRequestCount
  )
    return null;
  return Object.freeze({
    ...(parseQueueItem(detail, true) as AdminDisputeQueueItem),
    description: detail.description,
    desiredResolution: detail.desiredResolution,
    jobState: detail.jobState,
    conversationId: detail.conversationId,
    statements,
    evidence,
    informationRequests,
    internalNotes,
    outcomes,
    conversation,
    attachments,
  }) as unknown as AdminDisputeDetail;
}

export async function loadAdminDisputeQueue(
  fetcher: Fetcher,
  state?: AdminDisputeState,
): Promise<AdminReadResult<readonly AdminDisputeQueueItem[]>> {
  if (state !== undefined && !stateSet.has(state))
    return { status: "UNAVAILABLE" };
  const suffix =
    state === undefined ? "" : `?state=${encodeURIComponent(state)}`;
  return get(fetcher, `/v1/admin/disputes${suffix}`, parseAdminDisputeQueue);
}

export async function accessAdminDispute(
  fetcher: Fetcher,
  input: Readonly<{ disputeId: string; accessId: string; reason: string }>,
): Promise<AdminReadResult<AdminDisputeDetail>> {
  if (!id(input.disputeId) || !id(input.accessId) || !reason(input.reason))
    return { status: "UNAVAILABLE" };
  const response = await post(
    fetcher,
    `/v1/admin/disputes/${input.disputeId}/access`,
    {
      accessId: input.accessId,
      reason: input.reason,
    },
  );
  if (!("response" in response)) return response;
  if (!response.response.ok) return status(response.response);
  try {
    const detail = parseAdminDisputeDetail(await response.response.json());
    return detail === null
      ? { status: "UNAVAILABLE" }
      : { status: "OK", value: detail };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export type AdminDisputeCommand =
  | Readonly<{ action: "START_REVIEW" | "CLOSE" | "REOPEN" }>
  | Readonly<{
      action: "REQUEST_INFORMATION";
      recipient: "CUSTOMER" | "PRIMARY_PROVIDER" | "BOTH";
      requestText: string;
      replyDeadline: string | null;
    }>
  | Readonly<{ action: "ADD_INTERNAL_NOTE"; note: string }>
  | Readonly<{
      action: "RECORD_OUTCOME";
      category:
        | "RESOLVED_BY_PARTIES"
        | "OPERATIONAL_ADMIN_RESOLUTION"
        | "NO_ACTION"
        | "REFERRED_OUTSIDE_PLATFORM"
        | "ACCOUNT_POLICY_ACTION"
        | "OTHER";
      basis: "MUTUAL_PARTY_AGREEMENT" | "ADMINISTRATIVE_CLOSURE";
      summary: string;
    }>;

export async function sendAdminDisputeCommand(
  fetcher: Fetcher,
  input: Readonly<{
    disputeId: string;
    commandId: string;
    expectedState: AdminDisputeState;
    reason: string;
    command: AdminDisputeCommand;
  }>,
): Promise<AdminCommandResult> {
  if (
    !id(input.disputeId) ||
    !id(input.commandId) ||
    !stateSet.has(input.expectedState) ||
    !reason(input.reason)
  )
    return { status: "UNAVAILABLE" };
  const path = {
    START_REVIEW: "start-review",
    REQUEST_INFORMATION: "request-information",
    ADD_INTERNAL_NOTE: "internal-notes",
    RECORD_OUTCOME: "outcomes",
    CLOSE: "close",
    REOPEN: "reopen",
  }[input.command.action];
  const { action: _action, ...specific } = input.command;
  const result = await post(
    fetcher,
    `/v1/admin/disputes/${input.disputeId}/${path}`,
    {
      commandId: input.commandId,
      expectedState: input.expectedState,
      reason: input.reason,
      ...specific,
    },
  );
  if (!("response" in result)) return result;
  return parseCommandResponse(
    result.response,
    input.commandId,
    "state",
    input.disputeId,
  );
}

export async function sendAdminJobCorrection(
  fetcher: Fetcher,
  input:
    | Readonly<{
        kind: "COMPLETE";
        commandId: string;
        jobId: string;
        expectedState: "IN_PROGRESS" | "COMPLETION_REQUESTED";
        reason: string;
      }>
    | Readonly<{
        kind: "CANCEL";
        commandId: string;
        jobId: string;
        expectedState: "CONFIRMED" | "IN_PROGRESS" | "COMPLETION_REQUESTED";
        reason: string;
        userFacingReason: string;
      }>,
): Promise<AdminCommandResult> {
  if (!id(input.jobId) || !id(input.commandId) || !reason(input.reason))
    return { status: "UNAVAILABLE" };
  if (input.kind === "CANCEL" && !bounded(input.userFacingReason, 8, 1_000))
    return { status: "UNAVAILABLE" };
  const { kind: _kind, ...body } = input;
  const suffix = input.kind === "COMPLETE" ? "force-complete" : "force-cancel";
  const result = await post(
    fetcher,
    `/v1/admin/jobs/${input.jobId}/${suffix}`,
    body,
  );
  if (!("response" in result)) return result;
  return parseCommandResponse(result.response, input.commandId, "jobState");
}

async function get<T>(
  fetcher: Fetcher,
  path: string,
  parser: (value: unknown) => T | null,
): Promise<AdminReadResult<T>> {
  try {
    const response = await fetcher.call(globalThis, path, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return status(response);
    const value = parser(await response.json());
    return value === null ? { status: "UNAVAILABLE" } : { status: "OK", value };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

async function post(
  fetcher: Fetcher,
  path: string,
  body: Dict,
): Promise<
  | Readonly<{ response: Response }>
  | Readonly<{ status: "AUTH_REQUIRED" | "ACCESS_DENIED" | "UNAVAILABLE" }>
> {
  try {
    const token = await csrf(fetcher);
    if (token.status !== "OK") return token;
    return {
      response: await fetcher.call(globalThis, path, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": token.token,
        },
        body: JSON.stringify(body),
      }),
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

async function csrf(
  fetcher: Fetcher,
): Promise<
  | Readonly<{ status: "OK"; token: string }>
  | Readonly<{ status: "AUTH_REQUIRED" | "ACCESS_DENIED" | "UNAVAILABLE" }>
> {
  const response = await fetcher.call(globalThis, "/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const failure = status(response);
    if (failure.status === "AUTH_REQUIRED") return { status: "AUTH_REQUIRED" };
    if (failure.status === "ACCESS_DENIED") return { status: "ACCESS_DENIED" };
    return { status: "UNAVAILABLE" };
  }
  const body: unknown = await response.json();
  return record(body) &&
    exact(body, ["csrfToken"]) &&
    typeof body.csrfToken === "string" &&
    body.csrfToken.length >= 16
    ? { status: "OK", token: body.csrfToken }
    : { status: "UNAVAILABLE" };
}

async function parseCommandResponse(
  response: Response,
  expectedCommandId: string,
  stateKey: "state" | "jobState",
  expectedDisputeId?: string,
): Promise<AdminCommandResult> {
  if (!response.ok) {
    if (response.status === 409) {
      try {
        const body: unknown = await response.json();
        if (record(body) && exact(body, ["code"])) {
          if (body.code === "STALE_STATE") return { status: "STALE_STATE" };
          if (body.code === "IDEMPOTENCY_CONFLICT")
            return { status: "CONFLICT" };
        }
      } catch {
        return { status: "UNAVAILABLE" };
      }
    }
    return status(response);
  }
  try {
    const body: unknown = await response.json();
    const keys = [
      "status",
      "commandId",
      stateKey,
      "recordedAt",
      ...(expectedDisputeId === undefined ? [] : ["disputeId"]),
    ];
    if (
      !record(body) ||
      !exact(body, keys) ||
      (body.status !== "APPLIED" && body.status !== "DEDUPLICATED") ||
      body.commandId !== expectedCommandId ||
      (expectedDisputeId !== undefined &&
        body.disputeId !== expectedDisputeId) ||
      typeof body[stateKey] !== "string" ||
      !instant(body.recordedAt)
    )
      return { status: "UNAVAILABLE" };
    return {
      status: "OK",
      outcome: body.status,
      commandId: body.commandId,
      state: body[stateKey],
      recordedAt: body.recordedAt,
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

function status(response: Response): {
  status: "AUTH_REQUIRED" | "ACCESS_DENIED" | "NOT_FOUND" | "UNAVAILABLE";
} {
  if (response.status === 401) return { status: "AUTH_REQUIRED" };
  if (response.status === 403) return { status: "ACCESS_DENIED" };
  if (response.status === 404) return { status: "NOT_FOUND" };
  return { status: "UNAVAILABLE" };
}

function parseQueueItem(
  value: unknown,
  allowAdditional: boolean,
): AdminDisputeQueueItem | null {
  if (
    !record(value) ||
    (!allowAdditional && !exact(value, queueKeys)) ||
    !queueKeys.every((key) => Object.hasOwn(value, key)) ||
    !id(value.disputeId) ||
    !id(value.jobId) ||
    !bounded(value.category, 1, 80) ||
    typeof value.state !== "string" ||
    !stateSet.has(value.state) ||
    (value.openedByRole !== "CUSTOMER" &&
      value.openedByRole !== "PRIMARY_PROVIDER") ||
    !instant(value.createdAt) ||
    !instant(value.stateChangedAt) ||
    !integer(value.informationRequestCount, 0, 100_000)
  )
    return null;
  return value as unknown as AdminDisputeQueueItem;
}

function parseStatement(value: unknown) {
  return row(value, ["id", "authorRole", "kind", "body", "createdAt"]) &&
    id(value.id) &&
    bounded(value.authorRole, 1, 40) &&
    bounded(value.kind, 1, 80) &&
    bounded(value.body, 1, 10_000) &&
    instant(value.createdAt)
    ? value
    : null;
}
function parseEvidence(value: unknown) {
  return row(value, [
    "id",
    "submittedByRole",
    "mediaAssetId",
    "description",
    "createdAt",
  ]) &&
    id(value.id) &&
    bounded(value.submittedByRole, 1, 40) &&
    id(value.mediaAssetId) &&
    bounded(value.description, 1, 4_000) &&
    instant(value.createdAt)
    ? value
    : null;
}
function parseInformationRequest(value: unknown) {
  return row(value, [
    "id",
    "recipient",
    "requestText",
    "replyDeadline",
    "requestedAt",
  ]) &&
    id(value.id) &&
    ["CUSTOMER", "PRIMARY_PROVIDER", "BOTH"].includes(
      value.recipient as string,
    ) &&
    bounded(value.requestText, 1, 2_000) &&
    (value.replyDeadline === null || instant(value.replyDeadline)) &&
    instant(value.requestedAt)
    ? value
    : null;
}
function parseInternalNote(value: unknown) {
  return row(value, ["id", "body", "createdAt"]) &&
    id(value.id) &&
    bounded(value.body, 1, 4_000) &&
    instant(value.createdAt)
    ? value
    : null;
}
function parseOutcome(value: unknown) {
  return row(value, ["id", "category", "basis", "summary", "recordedAt"]) &&
    id(value.id) &&
    bounded(value.category, 1, 80) &&
    ["MUTUAL_PARTY_AGREEMENT", "ADMINISTRATIVE_CLOSURE"].includes(
      value.basis as string,
    ) &&
    bounded(value.summary, 1, 4_000) &&
    instant(value.recordedAt)
    ? value
    : null;
}
function parseConversationEntry(value: unknown) {
  return row(value, [
    "id",
    "sequence",
    "kind",
    "authorUserId",
    "body",
    "createdAt",
  ]) &&
    id(value.id) &&
    integer(value.sequence, 1, 1_000_000) &&
    bounded(value.kind, 1, 80) &&
    (value.authorUserId === null || id(value.authorUserId)) &&
    (value.body === null || bounded(value.body, 1, 20_000)) &&
    instant(value.createdAt)
    ? value
    : null;
}
function parseAttachment(value: unknown) {
  return row(value, [
    "mediaAssetId",
    "sourceMessageId",
    "mediaKind",
    "uploadedAt",
  ]) &&
    id(value.mediaAssetId) &&
    id(value.sourceMessageId) &&
    bounded(value.mediaKind, 1, 80) &&
    instant(value.uploadedAt)
    ? value
    : null;
}
function parseArray<T>(
  value: unknown,
  parser: (value: unknown) => T | null,
  maximum: number,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const parsed = value.map(parser);
  return parsed.some((item) => item === null)
    ? null
    : Object.freeze(parsed as T[]);
}
function row(value: unknown, keys: readonly string[]): value is Dict {
  return record(value) && exact(value, keys);
}
function record(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Dict, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
function id(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function bounded(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\p{Cc}]/u.test(value)
  );
}
function reason(value: string): boolean {
  return bounded(value, 8, 500);
}
function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
