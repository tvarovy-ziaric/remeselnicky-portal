const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const privateDownload =
  /^\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/download$/iu;
const calendar = /^\d{4}-\d{2}-\d{2}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
type Dict = Record<string, unknown>;
const record = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Dict, keys: readonly string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === "string" && uuid.test(v);
const time = (v: unknown): v is string =>
  typeof v === "string" &&
  instant.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const day = (v: unknown): v is string =>
  typeof v === "string" &&
  calendar.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const bounded = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.trim().length > 0 &&
  v.length <= max &&
  !/[\p{Cc}]/u.test(v.replace(/[\n\t]/gu, ""));
const lines = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 50 && v.every((line) => bounded(line, 500));
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const nullable = <T>(
  v: unknown,
  test: (value: unknown) => value is T,
): v is T | null => v === null || test(v);

export type Side = "CUSTOMER" | "PRIMARY_PROVIDER";
export type ChangeState =
  "DRAFT" | "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED";
export type PriceImpact =
  | { mode: "NONE" }
  | {
      mode: "FIXED_DELTA" | "ESTIMATE_DELTA";
      amountCents: number;
      vatStatus: "VAT_INCLUDED" | "VAT_EXCLUDED" | "NOT_VAT_REGISTERED";
      basis?: string;
    }
  | {
      mode: "RANGE_DELTA";
      minimumCents: number;
      maximumCents: number;
      basis: string;
      vatStatus: "VAT_INCLUDED" | "VAT_EXCLUDED" | "NOT_VAT_REGISTERED";
    };
export type ScheduleImpact =
  | { mode: "NONE" }
  | { mode: "DAYS"; deltaDays: number }
  | { mode: "DATE"; newDate: string }
  | { mode: "RANGE"; startDate: string; endDate: string };
export interface ChangeTerms {
  title: string;
  reason: string;
  changeDescription: string;
  scopeAdded: string[];
  scopeRemoved: string[];
  scopeChanged: string[];
  priceImpact: PriceImpact;
  scheduleImpact: ScheduleImpact;
  materialResponsibility: "PROVIDER" | "CUSTOMER" | "MIXED" | null;
  warrantyChange: string | null;
  otherConditionChange: string | null;
  affectedMilestoneIds: string[];
  externalPdfDownloadPath: string | null;
}
export interface ChangeSummary {
  changeOrderId: string;
  revisionId: string;
  revisionNumber: number;
  state: ChangeState;
  title: string;
  authoredSide: Side;
  createdAt: string;
}
export interface ChangeRevision {
  revisionId: string;
  revisionNumber: number;
  state: ChangeState;
  authoredSide: Side;
  terms: ChangeTerms;
  pdfContentSha256: string | null;
  createdAt: string;
  stateChangedAt: string | null;
}
export interface ChangeDetail {
  changeOrderId: string;
  jobId: string;
  createdBySide: Side;
  createdAt: string;
  revisions: ChangeRevision[];
  actions: {
    id: string;
    revisionId: string;
    sequence: number;
    action: string;
    supersededByRevisionId: string | null;
    occurredAt: string;
  }[];
}
export interface ChangePage {
  items: ChangeSummary[];
  nextCursor: { createdAt: string; changeOrderId: string } | null;
}
export type Load<T> =
  | { status: "OK"; value: T }
  | { status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };
const side = (v: unknown): v is Side =>
  v === "CUSTOMER" || v === "PRIMARY_PROVIDER";
const state = (v: unknown): v is ChangeState =>
  [
    "DRAFT",
    "PROPOSED",
    "APPROVED",
    "REJECTED",
    "WITHDRAWN",
    "SUPERSEDED",
  ].includes(String(v));
const vat = (v: unknown) =>
  ["VAT_INCLUDED", "VAT_EXCLUDED", "NOT_VAT_REGISTERED"].includes(String(v));
function price(v: unknown): v is PriceImpact {
  if (!record(v)) return false;
  if (v.mode === "NONE") return exact(v, ["mode"]);
  if (!vat(v.vatStatus)) return false;
  if (v.mode === "FIXED_DELTA" || v.mode === "ESTIMATE_DELTA")
    return (
      exact(
        v,
        v.mode === "FIXED_DELTA"
          ? ["mode", "amountCents", "vatStatus"]
          : ["mode", "amountCents", "basis", "vatStatus"],
      ) &&
      integer(v.amountCents, -1e12, 1e12) &&
      v.amountCents !== 0 &&
      (v.mode === "FIXED_DELTA" || bounded(v.basis, 500))
    );
  if (v.mode === "RANGE_DELTA")
    return (
      exact(v, [
        "mode",
        "minimumCents",
        "maximumCents",
        "basis",
        "vatStatus",
      ]) &&
      integer(v.minimumCents, -1e12, 1e12) &&
      integer(v.maximumCents, -1e12, 1e12) &&
      v.minimumCents <= v.maximumCents &&
      (v.minimumCents !== 0 || v.maximumCents !== 0) &&
      bounded(v.basis, 500)
    );
  return false;
}
function schedule(v: unknown): v is ScheduleImpact {
  if (!record(v)) return false;
  if (v.mode === "NONE") return exact(v, ["mode"]);
  if (v.mode === "DAYS")
    return (
      exact(v, ["mode", "deltaDays"]) &&
      integer(v.deltaDays, -3650, 3650) &&
      v.deltaDays !== 0
    );
  if (v.mode === "DATE") return exact(v, ["mode", "newDate"]) && day(v.newDate);
  if (v.mode === "RANGE")
    return (
      exact(v, ["mode", "startDate", "endDate"]) &&
      day(v.startDate) &&
      day(v.endDate) &&
      v.startDate <= v.endDate
    );
  return false;
}
const termKeys = [
  "title",
  "reason",
  "changeDescription",
  "scopeAdded",
  "scopeRemoved",
  "scopeChanged",
  "priceImpact",
  "scheduleImpact",
  "materialResponsibility",
  "warrantyChange",
  "otherConditionChange",
  "affectedMilestoneIds",
  "externalPdfDownloadPath",
];
export function parseChangeTerms(v: unknown): ChangeTerms | null {
  if (
    !record(v) ||
    !exact(v, termKeys) ||
    !bounded(v.title, 160) ||
    !bounded(v.reason, 500) ||
    !bounded(v.changeDescription, 4000) ||
    !lines(v.scopeAdded) ||
    !lines(v.scopeRemoved) ||
    !lines(v.scopeChanged) ||
    !price(v.priceImpact) ||
    !schedule(v.scheduleImpact) ||
    ![null, "PROVIDER", "CUSTOMER", "MIXED"].includes(
      v.materialResponsibility as string | null,
    ) ||
    !nullable(v.warrantyChange, (x): x is string => bounded(x, 1000)) ||
    !nullable(v.otherConditionChange, (x): x is string => bounded(x, 1000)) ||
    !Array.isArray(v.affectedMilestoneIds) ||
    v.affectedMilestoneIds.length > 50 ||
    !v.affectedMilestoneIds.every(id) ||
    new Set(v.affectedMilestoneIds).size !== v.affectedMilestoneIds.length ||
    !(
      v.externalPdfDownloadPath === null ||
      (typeof v.externalPdfDownloadPath === "string" &&
        privateDownload.test(v.externalPdfDownloadPath))
    )
  )
    return null;
  if (
    v.scopeAdded.length + v.scopeRemoved.length + v.scopeChanged.length === 0 &&
    v.priceImpact.mode === "NONE" &&
    v.scheduleImpact.mode === "NONE" &&
    v.materialResponsibility === null &&
    v.warrantyChange === null &&
    v.otherConditionChange === null
  )
    return null;
  return v as unknown as ChangeTerms;
}
export function parseChangeSummary(v: unknown): ChangeSummary | null {
  return record(v) &&
    exact(v, [
      "changeOrderId",
      "revisionId",
      "revisionNumber",
      "state",
      "title",
      "authoredSide",
      "createdAt",
    ]) &&
    id(v.changeOrderId) &&
    id(v.revisionId) &&
    integer(v.revisionNumber, 1, 2147483647) &&
    state(v.state) &&
    bounded(v.title, 160) &&
    side(v.authoredSide) &&
    time(v.createdAt)
    ? (v as unknown as ChangeSummary)
    : null;
}
export function parseChangeRevision(
  v: unknown,
  expectedRevisionId?: string,
): ChangeRevision | null {
  return record(v) &&
    exact(v, [
      "revisionId",
      "revisionNumber",
      "state",
      "authoredSide",
      "terms",
      "pdfContentSha256",
      "createdAt",
      "stateChangedAt",
    ]) &&
    id(v.revisionId) &&
    (expectedRevisionId === undefined || v.revisionId === expectedRevisionId) &&
    integer(v.revisionNumber, 1, 2147483647) &&
    state(v.state) &&
    side(v.authoredSide) &&
    parseChangeTerms(v.terms) !== null &&
    nullable(
      v.pdfContentSha256,
      (x): x is string => typeof x === "string" && /^[a-f0-9]{64}$/iu.test(x),
    ) &&
    time(v.createdAt) &&
    nullable(v.stateChangedAt, time)
    ? (v as unknown as ChangeRevision)
    : null;
}
export function parseChangePage(v: unknown): ChangePage | null {
  if (
    !record(v) ||
    !exact(v, ["items", "nextCursor"]) ||
    !Array.isArray(v.items) ||
    v.items.length > 20 ||
    !v.items.every((x) => parseChangeSummary(x) !== null) ||
    !(
      v.nextCursor === null ||
      (record(v.nextCursor) &&
        exact(v.nextCursor, ["createdAt", "changeOrderId"]) &&
        time(v.nextCursor.createdAt) &&
        id(v.nextCursor.changeOrderId))
    )
  )
    return null;
  const items = v.items as ChangeSummary[];
  if (new Set(items.map((x) => x.changeOrderId)).size !== items.length)
    return null;
  return v as unknown as ChangePage;
}
export function parseChangeDetail(
  v: unknown,
  jobId: string,
  changeOrderId: string,
): ChangeDetail | null {
  if (
    !record(v) ||
    !exact(v, [
      "changeOrderId",
      "jobId",
      "createdBySide",
      "createdAt",
      "revisions",
      "actions",
    ]) ||
    v.jobId !== jobId ||
    v.changeOrderId !== changeOrderId ||
    !id(jobId) ||
    !id(changeOrderId) ||
    !side(v.createdBySide) ||
    !time(v.createdAt) ||
    !Array.isArray(v.revisions) ||
    v.revisions.length > 100 ||
    !v.revisions.every((x) => parseChangeRevision(x) !== null) ||
    !Array.isArray(v.actions) ||
    v.actions.length > 200 ||
    !v.actions.every(
      (a) =>
        record(a) &&
        exact(a, [
          "id",
          "revisionId",
          "sequence",
          "action",
          "supersededByRevisionId",
          "occurredAt",
        ]) &&
        id(a.id) &&
        id(a.revisionId) &&
        integer(a.sequence, 1, 2147483647) &&
        ["PROPOSE", "APPROVE", "REJECT", "WITHDRAW", "SUPERSEDE"].includes(
          String(a.action),
        ) &&
        nullable(a.supersededByRevisionId, id) &&
        time(a.occurredAt),
    )
  )
    return null;
  const revisions = v.revisions as ChangeRevision[];
  if (
    new Set(revisions.map((r) => r.revisionId)).size !== revisions.length ||
    new Set(revisions.map((r) => r.revisionNumber)).size !== revisions.length ||
    v.actions.some(
      (a: Dict) => !revisions.some((r) => r.revisionId === a.revisionId),
    )
  )
    return null;
  return v as unknown as ChangeDetail;
}
async function get<T>(
  fetcher: typeof fetch,
  path: string,
  parse: (v: unknown) => T | null,
): Promise<Load<T>> {
  try {
    const response = await fetcher.call(globalThis, path, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const value = parse(await response.json());
    return value === null ? { status: "UNAVAILABLE" } : { status: "OK", value };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
const base = (jobId: string) => `/v1/me/jobs/${jobId}/change-orders`;
export function loadChangeOrders(
  fetcher: typeof fetch,
  jobId: string,
  cursor?: ChangePage["nextCursor"],
): Promise<Load<ChangePage>> {
  if (
    !id(jobId) ||
    (cursor && (!time(cursor.createdAt) || !id(cursor.changeOrderId)))
  )
    return Promise.resolve({ status: "UNAVAILABLE" });
  const query = cursor
    ? `?limit=20&afterCreatedAt=${encodeURIComponent(cursor.createdAt)}&afterId=${cursor.changeOrderId}`
    : "?limit=20";
  return get(fetcher, base(jobId) + query, parseChangePage);
}
export function loadChangeDetail(
  fetcher: typeof fetch,
  jobId: string,
  changeOrderId: string,
): Promise<Load<ChangeDetail>> {
  if (!id(jobId) || !id(changeOrderId))
    return Promise.resolve({ status: "UNAVAILABLE" });
  return get(fetcher, `${base(jobId)}/${changeOrderId}`, (v) =>
    parseChangeDetail(v, jobId, changeOrderId),
  );
}
export function loadExactRevision(
  fetcher: typeof fetch,
  jobId: string,
  changeOrderId: string,
  revisionId: string,
): Promise<Load<ChangeRevision>> {
  if (![jobId, changeOrderId, revisionId].every(id))
    return Promise.resolve({ status: "UNAVAILABLE" });
  return get(
    fetcher,
    `${base(jobId)}/${changeOrderId}/revisions/${revisionId}`,
    (v) => parseChangeRevision(v, revisionId),
  );
}
export type ChangeCommand =
  | {
      kind: "CREATE";
      revisionId: string;
      terms: ChangeTerms;
      externalPdfMediaAssetId?: string | null;
    }
  | {
      kind: "REPLACE";
      changeOrderId: string;
      expectedRevisionId: string;
      terms: ChangeTerms;
      externalPdfMediaAssetId?: string | null;
    }
  | {
      kind: "COUNTERPROPOSE";
      changeOrderId: string;
      expectedRevisionId: string;
      terms: ChangeTerms;
      externalPdfMediaAssetId?: string | null;
    }
  | {
      kind: "PROPOSE";
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
    }
  | {
      kind: "APPROVE";
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
    }
  | {
      kind: "REJECT";
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
    }
  | {
      kind: "WITHDRAW";
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
    };
export type CommandResult =
  | {
      status: "OK";
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
      state: ChangeState;
    }
  | { status: "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE" };
export async function sendChangeCommand(
  fetcher: typeof fetch,
  jobId: string,
  commandId: string,
  command: ChangeCommand,
): Promise<CommandResult> {
  if (!id(jobId) || !id(commandId)) return { status: "UNAVAILABLE" };
  if (command.kind === "CREATE") {
    if (
      !id(command.revisionId) ||
      !parseChangeTerms(command.terms) ||
      (command.externalPdfMediaAssetId !== undefined &&
        command.externalPdfMediaAssetId !== null &&
        !id(command.externalPdfMediaAssetId))
    )
      return { status: "UNAVAILABLE" };
  } else if (command.kind === "REPLACE" || command.kind === "COUNTERPROPOSE") {
    if (
      !id(command.changeOrderId) ||
      !id(command.expectedRevisionId) ||
      !parseChangeTerms(command.terms) ||
      (command.externalPdfMediaAssetId !== undefined &&
        command.externalPdfMediaAssetId !== null &&
        !id(command.externalPdfMediaAssetId))
    )
      return { status: "UNAVAILABLE" };
  } else if (
    !id(command.changeOrderId) ||
    !id(command.revisionId) ||
    !integer(command.revisionNumber, 1, 2147483647)
  )
    return { status: "UNAVAILABLE" };
  try {
    const csrfResponse = await fetcher.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrfResponse.status === 401) return { status: "AUTH_REQUIRED" };
    if (!csrfResponse.ok) return { status: "UNAVAILABLE" };
    const csrf: unknown = await csrfResponse.json();
    if (
      !record(csrf) ||
      !exact(csrf, ["csrfToken"]) ||
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1000
    )
      return { status: "UNAVAILABLE" };
    const path =
      command.kind === "CREATE"
        ? base(jobId)
        : `${base(jobId)}/${command.changeOrderId}/${command.kind.toLowerCase()}`;
    let body: unknown;
    if (command.kind === "CREATE")
      body = {
        commandId,
        revisionId: command.revisionId,
        terms: wireTerms(command.terms, command.externalPdfMediaAssetId),
      };
    else if (command.kind === "REPLACE" || command.kind === "COUNTERPROPOSE")
      body = {
        commandId,
        expectedRevisionId: command.expectedRevisionId,
        terms: wireTerms(command.terms, command.externalPdfMediaAssetId),
      };
    else
      body = {
        commandId,
        revisionId: command.revisionId,
        revisionNumber: command.revisionNumber,
      };
    const response = await fetcher.call(globalThis, path, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrf.csrfToken,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) return { status: "CONFLICT" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const result: unknown = await response.json();
    if (
      !record(result) ||
      !exact(result, [
        "status",
        "changeOrderId",
        "revisionId",
        "revisionNumber",
        "state",
        "occurredAt",
      ]) ||
      !["APPLIED", "DEDUPLICATED"].includes(String(result.status)) ||
      !id(result.changeOrderId) ||
      !id(result.revisionId) ||
      !integer(result.revisionNumber, 1, 2147483647) ||
      !state(result.state) ||
      !time(result.occurredAt) ||
      (command.kind !== "CREATE" &&
        result.changeOrderId !== command.changeOrderId)
    )
      return { status: "UNAVAILABLE" };
    if (
      command.kind === "CREATE" &&
      (result.revisionId !== command.revisionId ||
        result.state !== "DRAFT" ||
        result.revisionNumber !== 1)
    )
      return { status: "UNAVAILABLE" };
    if (
      (command.kind === "REPLACE" || command.kind === "COUNTERPROPOSE") &&
      (result.revisionId !== commandId ||
        result.state !== (command.kind === "REPLACE" ? "DRAFT" : "PROPOSED"))
    )
      return { status: "UNAVAILABLE" };
    if (
      command.kind === "PROPOSE" ||
      command.kind === "APPROVE" ||
      command.kind === "REJECT" ||
      command.kind === "WITHDRAW"
    ) {
      const expectedState =
        command.kind === "PROPOSE"
          ? "PROPOSED"
          : command.kind === "APPROVE"
            ? "APPROVED"
            : command.kind === "REJECT"
              ? "REJECTED"
              : "WITHDRAWN";
      if (
        result.revisionId !== command.revisionId ||
        result.revisionNumber !== command.revisionNumber ||
        result.state !== expectedState
      )
        return { status: "UNAVAILABLE" };
    }
    return {
      status: "OK",
      changeOrderId: result.changeOrderId,
      revisionId: result.revisionId,
      revisionNumber: result.revisionNumber,
      state: result.state,
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
function wireTerms(
  terms: ChangeTerms,
  externalPdfMediaAssetId?: string | null,
) {
  return {
    title: terms.title,
    reason: terms.reason,
    changeDescription: terms.changeDescription,
    scopeAdded: terms.scopeAdded,
    scopeRemoved: terms.scopeRemoved,
    scopeChanged: terms.scopeChanged,
    priceImpact: terms.priceImpact,
    scheduleImpact: terms.scheduleImpact,
    materialResponsibility: terms.materialResponsibility,
    warrantyChange: terms.warrantyChange,
    otherConditionChange: terms.otherConditionChange,
    affectedMilestoneIds: terms.affectedMilestoneIds,
    externalPdfMediaAssetId: externalPdfMediaAssetId ?? null,
  };
}

export interface PdfReservation {
  readonly status: "AUTHORIZED" | "DEDUPLICATED";
  readonly reservationId: string;
  readonly revisionNumber: number;
  readonly expiresAt: string;
}
export interface PdfUpload {
  readonly status: "PROCESSING";
  readonly assetId: string;
}
export interface PdfStatus {
  readonly status: "PROCESSING" | "READY" | "REJECTED";
  readonly expiresAt: string;
  readonly canCreateRevision: boolean;
}
export type PdfResult<T> =
  | { readonly status: "OK"; readonly value: T }
  | {
      readonly status:
        "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";
    };
async function csrf(fetcher: typeof fetch): Promise<string | null> {
  const response = await fetcher.call(globalThis, "/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  const data: unknown = await response.json();
  return record(data) &&
    exact(data, ["csrfToken"]) &&
    typeof data.csrfToken === "string" &&
    data.csrfToken.length > 0 &&
    data.csrfToken.length <= 1000
    ? data.csrfToken
    : null;
}
function pdfResponse(response: Response): PdfResult<never> | null {
  if (response.status === 401) return { status: "AUTH_REQUIRED" };
  if (response.status === 404) return { status: "NOT_FOUND" };
  if (response.status === 409) return { status: "CONFLICT" };
  if (!response.ok) return { status: "UNAVAILABLE" };
  return null;
}
export async function reserveChangePdf(
  fetcher: typeof fetch,
  input: {
    jobId: string;
    commandId: string;
    changeOrderId: string;
    revisionId: string;
    expectedRevisionId: string | null;
  },
): Promise<PdfResult<PdfReservation>> {
  if (
    ![
      input.jobId,
      input.commandId,
      input.changeOrderId,
      input.revisionId,
    ].every(id) ||
    (input.expectedRevisionId !== null && !id(input.expectedRevisionId)) ||
    (input.expectedRevisionId === null &&
      input.commandId !== input.changeOrderId) ||
    (input.expectedRevisionId !== null && input.commandId !== input.revisionId)
  )
    return { status: "UNAVAILABLE" };
  try {
    const token = await csrf(fetcher);
    if (token === null) return { status: "UNAVAILABLE" };
    const response = await fetcher.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/change-order-pdf-reservations`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": token,
        },
        body: JSON.stringify({
          commandId: input.commandId,
          changeOrderId: input.changeOrderId,
          revisionId: input.revisionId,
          expectedRevisionId: input.expectedRevisionId,
        }),
      },
    );
    const failure = pdfResponse(response);
    if (failure) return failure;
    const value: unknown = await response.json();
    if (
      !record(value) ||
      !exact(value, [
        "status",
        "reservationId",
        "revisionNumber",
        "expiresAt",
      ]) ||
      !["AUTHORIZED", "DEDUPLICATED"].includes(String(value.status)) ||
      value.reservationId !== input.commandId ||
      !integer(value.revisionNumber, 1, 2147483647) ||
      !time(value.expiresAt)
    )
      return { status: "UNAVAILABLE" };
    return { status: "OK", value: value as unknown as PdfReservation };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
export async function uploadChangePdf(
  fetcher: typeof fetch,
  input: { jobId: string; revisionId: string; file: File },
): Promise<PdfResult<PdfUpload>> {
  if (
    !id(input.jobId) ||
    !id(input.revisionId) ||
    input.file.type !== "application/pdf" ||
    input.file.size < 1 ||
    input.file.size > 25 * 1024 * 1024
  )
    return { status: "UNAVAILABLE" };
  try {
    const token = await csrf(fetcher);
    if (token === null) return { status: "UNAVAILABLE" };
    const response = await fetcher.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/change-order-revisions/${input.revisionId}/pdf`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/pdf",
          "x-csrf-token": token,
        },
        body: input.file,
      },
    );
    const failure = pdfResponse(response);
    if (failure) return failure;
    if (response.status !== 202) return { status: "UNAVAILABLE" };
    const value: unknown = await response.json();
    if (
      !record(value) ||
      !exact(value, ["status", "assetId"]) ||
      value.status !== "PROCESSING" ||
      !id(value.assetId)
    )
      return { status: "UNAVAILABLE" };
    return { status: "OK", value: value as unknown as PdfUpload };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
export function loadChangePdfStatus(
  fetcher: typeof fetch,
  input: { jobId: string; revisionId: string; mediaAssetId: string },
): Promise<Load<PdfStatus>> {
  if (![input.jobId, input.revisionId, input.mediaAssetId].every(id))
    return Promise.resolve({ status: "UNAVAILABLE" });
  return get(
    fetcher,
    `/v1/me/jobs/${input.jobId}/change-order-revisions/${input.revisionId}/pdf/${input.mediaAssetId}/status`,
    (value) =>
      record(value) &&
      exact(value, ["status", "expiresAt", "canCreateRevision"]) &&
      ["PROCESSING", "READY", "REJECTED"].includes(String(value.status)) &&
      time(value.expiresAt) &&
      typeof value.canCreateRevision === "boolean" &&
      (value.status !== "PROCESSING" || value.canCreateRevision === false)
        ? (value as unknown as PdfStatus)
        : null,
  );
}
export type PdfChangeCommand = Extract<
  ChangeCommand,
  { kind: "CREATE" | "REPLACE" | "COUNTERPROPOSE" }
>;
export interface PendingChangePdf {
  readonly jobId: string;
  readonly commandId: string;
  readonly revisionId: string;
  readonly mediaAssetId: string;
  readonly expiresAt: string;
  readonly command: PdfChangeCommand;
}
export type PdfWorkflowResult =
  | { readonly status: "OK"; readonly result: CommandResult & { status: "OK" } }
  | { readonly status: "PROCESSING"; readonly pending: PendingChangePdf }
  | {
      readonly status:
        | "AUTH_REQUIRED"
        | "NOT_FOUND"
        | "CONFLICT"
        | "REJECTED"
        | "EXPIRED"
        | "UNAVAILABLE";
    };
export async function startChangePdf(
  fetcher: typeof fetch,
  jobId: string,
  commandId: string,
  command: PdfChangeCommand,
  file: File,
  onProgress: (message: string) => void,
): Promise<PdfWorkflowResult> {
  const revisionId = command.kind === "CREATE" ? command.revisionId : commandId;
  const changeOrderId =
    command.kind === "CREATE" ? commandId : command.changeOrderId;
  const expectedRevisionId =
    command.kind === "CREATE" ? null : command.expectedRevisionId;
  if (
    !id(jobId) ||
    !id(commandId) ||
    !id(revisionId) ||
    !id(changeOrderId) ||
    (expectedRevisionId !== null && !id(expectedRevisionId)) ||
    parseChangeTerms(command.terms) === null
  )
    return { status: "UNAVAILABLE" };
  onProgress("Rezervujem presnú revíziu PDF dodatku…");
  const reserved = await reserveChangePdf(fetcher, {
    jobId,
    commandId,
    changeOrderId,
    revisionId,
    expectedRevisionId,
  });
  if (reserved.status !== "OK") return { status: reserved.status };
  onProgress("Nahrávam PDF na súkromné spracovanie…");
  const uploaded = await uploadChangePdf(fetcher, { jobId, revisionId, file });
  if (uploaded.status !== "OK") return { status: uploaded.status };
  return resumeChangePdf(
    fetcher,
    {
      jobId,
      commandId,
      revisionId,
      mediaAssetId: uploaded.value.assetId,
      expiresAt: reserved.value.expiresAt,
      command,
    },
    onProgress,
  );
}
export async function resumeChangePdf(
  fetcher: typeof fetch,
  pending: PendingChangePdf,
  onProgress: (message: string) => void,
): Promise<PdfWorkflowResult> {
  if (
    ![
      pending.jobId,
      pending.commandId,
      pending.revisionId,
      pending.mediaAssetId,
    ].every(id) ||
    !time(pending.expiresAt)
  )
    return { status: "UNAVAILABLE" };
  for (let attempt = 0; attempt < 8; attempt++) {
    if (Date.parse(pending.expiresAt) <= Date.now())
      return { status: "EXPIRED" };
    onProgress("PDF sa bezpečne spracúva. Čakám na výsledok kontroly…");
    const read = await loadChangePdfStatus(fetcher, {
      jobId: pending.jobId,
      revisionId: pending.revisionId,
      mediaAssetId: pending.mediaAssetId,
    });
    if (read.status !== "OK") return { status: read.status };
    if (read.value.status === "REJECTED") return { status: "REJECTED" };
    if (
      Date.parse(read.value.expiresAt) <= Date.now() ||
      (!read.value.canCreateRevision && read.value.status === "READY")
    )
      return { status: "EXPIRED" };
    if (read.value.status === "READY") {
      onProgress("PDF je pripravené. Ukladám revíziu dodatku…");
      const result = await sendChangeCommand(
        fetcher,
        pending.jobId,
        pending.commandId,
        { ...pending.command, externalPdfMediaAssetId: pending.mediaAssetId },
      );
      return result.status === "OK"
        ? { status: "OK", result }
        : { status: result.status };
    }
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { status: "PROCESSING", pending };
}
