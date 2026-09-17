import {
  parseJobDocumentPage,
  type JobDocumentItem,
} from "./job-documentation";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const displayName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 255 &&
  !/[\p{Cc}]/u.test(value);
const bodyText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 2_000 &&
  !/[\p{Cc}]/u.test(value.replace(/[\n\t]/gu, ""));

export interface OperationalCursor {
  readonly createdAt: string;
  readonly id: string;
}
export interface ProgressItem {
  readonly id: string;
  readonly jobId: string;
  readonly authorDisplayName: string;
  readonly body: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly media: readonly JobDocumentItem[];
}
export interface IssueItem {
  readonly id: string;
  readonly jobId: string;
  readonly authorDisplayName: string;
  readonly authorRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly kind: "PROBLEM" | "DELAY" | "WAITING";
  readonly body: string;
  readonly createdAt: string;
  readonly media: readonly JobDocumentItem[];
}
export interface IssueComment {
  readonly id: string;
  readonly authorDisplayName: string;
  readonly authorRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly body: string;
  readonly createdAt: string;
}
export interface OperationalPage<T> {
  readonly items: readonly T[];
  readonly canCreate: boolean;
  readonly nextCursor: OperationalCursor | null;
}

function parseMedia(
  value: unknown,
  photoOnly: boolean,
): readonly JobDocumentItem[] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  for (const raw of value as unknown[]) {
    if (
      !record(raw) ||
      !exact(raw, [
        "mediaAssetId",
        "kind",
        "source",
        "sourceMessageId",
        "uploadedByUserId",
        "authorRole",
        "uploadedAt",
        "capturedAt",
        "chronologicalAt",
        "displayFilename",
        "contentType",
        "downloadPath",
      ]) ||
      !iso(raw.uploadedAt) ||
      (raw.capturedAt !== null && !iso(raw.capturedAt)) ||
      !iso(raw.chronologicalAt) ||
      (photoOnly && raw.kind !== "PHOTO")
    )
      return null;
  }
  return (
    parseJobDocumentPage({ items: value, nextCursor: null })?.items ?? null
  );
}
export type OperationalLoad<T> =
  | { readonly status: "OK"; readonly page: OperationalPage<T> }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" };
export type OperationalCommand = "OK" | "AUTH_REQUIRED" | "UNAVAILABLE";

function parsePage<T extends { id: string; createdAt: string }>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): OperationalPage<T> | null {
  if (
    !record(value) ||
    !exact(value, ["items", "canCreate", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    typeof value.canCreate !== "boolean"
  )
    return null;
  const ids = new Set<string>();
  const items: T[] = [];
  for (const raw of value.items as unknown[]) {
    const item = parseItem(raw);
    if (!item || ids.has(item.id)) return null;
    ids.add(item.id);
    items.push(item);
  }
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (!record(cursor) ||
      !exact(cursor, ["createdAt", "id"]) ||
      !iso(cursor.createdAt) ||
      typeof cursor.id !== "string" ||
      !uuid.test(cursor.id) ||
      items.at(-1)?.id !== cursor.id ||
      items.at(-1)?.createdAt !== cursor.createdAt)
  )
    return null;
  return {
    items,
    canCreate: value.canCreate,
    nextCursor: cursor as OperationalCursor | null,
  };
}

export function parseProgressPage(
  value: unknown,
  jobId: string,
): OperationalPage<ProgressItem> | null {
  return parsePage(value, (raw) => {
    if (
      !record(raw) ||
      !exact(raw, [
        "id",
        "jobId",
        "authorDisplayName",
        "body",
        "createdAt",
        "acknowledgedAt",
        "media",
      ]) ||
      typeof raw.id !== "string" ||
      !uuid.test(raw.id) ||
      raw.jobId !== jobId ||
      !displayName(raw.authorDisplayName) ||
      !bodyText(raw.body) ||
      !iso(raw.createdAt) ||
      (raw.acknowledgedAt !== null && !iso(raw.acknowledgedAt)) ||
      (raw.acknowledgedAt !== null &&
        Date.parse(raw.acknowledgedAt) < Date.parse(raw.createdAt)) ||
      parseMedia(raw.media, true) === null
    )
      return null;
    return raw as unknown as ProgressItem;
  });
}

export function parseIssuePage(
  value: unknown,
  jobId: string,
): OperationalPage<IssueItem> | null {
  return parsePage(value, (raw) => {
    if (
      !record(raw) ||
      !exact(raw, [
        "id",
        "jobId",
        "authorDisplayName",
        "authorRole",
        "kind",
        "body",
        "createdAt",
        "media",
      ]) ||
      typeof raw.id !== "string" ||
      !uuid.test(raw.id) ||
      raw.jobId !== jobId ||
      !displayName(raw.authorDisplayName) ||
      !["CUSTOMER", "PRIMARY_PROVIDER"].includes(String(raw.authorRole)) ||
      !["PROBLEM", "DELAY", "WAITING"].includes(String(raw.kind)) ||
      !bodyText(raw.body) ||
      !iso(raw.createdAt) ||
      parseMedia(raw.media, false) === null
    )
      return null;
    return raw as unknown as IssueItem;
  });
}

export function parseCommentPage(
  value: unknown,
): OperationalPage<IssueComment> | null {
  return parsePage(value, (raw) => {
    if (
      !record(raw) ||
      !exact(raw, [
        "id",
        "authorDisplayName",
        "authorRole",
        "body",
        "createdAt",
      ]) ||
      typeof raw.id !== "string" ||
      !uuid.test(raw.id) ||
      !displayName(raw.authorDisplayName) ||
      !["CUSTOMER", "PRIMARY_PROVIDER"].includes(String(raw.authorRole)) ||
      !bodyText(raw.body) ||
      !iso(raw.createdAt)
    )
      return null;
    return raw as unknown as IssueComment;
  });
}

type LoadInput = {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly cursor?: OperationalCursor | null;
};
export function loadOperationalPage(
  input: LoadInput & { readonly kind: "progress" },
): Promise<OperationalLoad<ProgressItem>>;
export function loadOperationalPage(
  input: LoadInput & { readonly kind: "issues" },
): Promise<OperationalLoad<IssueItem>>;
export function loadOperationalPage(
  input: LoadInput & { readonly kind: "comments"; readonly issueId: string },
): Promise<OperationalLoad<IssueComment>>;
export async function loadOperationalPage(
  input: LoadInput &
    (
      | { readonly kind: "progress" }
      | { readonly kind: "issues" }
      | { readonly kind: "comments"; readonly issueId: string }
    ),
): Promise<OperationalLoad<ProgressItem | IssueItem | IssueComment>> {
  if (
    !uuid.test(input.jobId) ||
    (input.kind === "comments" && !uuid.test(input.issueId)) ||
    (input.cursor !== undefined &&
      input.cursor !== null &&
      (!iso(input.cursor.createdAt) || !uuid.test(input.cursor.id)))
  )
    return { status: "UNAVAILABLE" };
  const suffix =
    input.kind === "comments" ? `issues/${input.issueId}/comments` : input.kind;
  const query = new URLSearchParams({ limit: "20" });
  if (input.cursor) {
    query.set("beforeAt", input.cursor.createdAt);
    query.set("beforeId", input.cursor.id);
  }
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/${suffix}?${query}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const raw: unknown = await response.json();
    const page =
      input.kind === "progress"
        ? parseProgressPage(raw, input.jobId)
        : input.kind === "issues"
          ? parseIssuePage(raw, input.jobId)
          : parseCommentPage(raw);
    return page ? { status: "OK", page } : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function commandAttempt<T>(
  current: { readonly commandId: string; readonly intent: T } | null,
  intent: T,
  createId: () => string,
): { readonly commandId: string; readonly intent: T } {
  return current && JSON.stringify(current.intent) === JSON.stringify(intent)
    ? current
    : { commandId: createId(), intent };
}

export async function sendOperationalCommand(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly path:
    | "progress"
    | "issues"
    | `issues/${string}/comments`
    | `progress/${string}/acknowledge`;
  readonly commandId: string;
  readonly body?: string;
  readonly kind?: "PROBLEM" | "DELAY" | "WAITING";
  readonly mediaAssetIds?: readonly string[];
}): Promise<OperationalCommand> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.commandId) ||
    !/^(?:progress|issues|issues\/[0-9a-f-]+\/comments|progress\/[0-9a-f-]+\/acknowledge)$/iu.test(
      input.path,
    ) ||
    (input.path !== "progress" &&
      input.path !== "issues" &&
      !uuid.test(input.path.split("/")[1] ?? "")) ||
    (input.body !== undefined && !bodyText(input.body)) ||
    (input.path === "progress" && input.body === undefined) ||
    (input.path === "issues" &&
      (input.body === undefined ||
        input.body.trim().length < 8 ||
        !["PROBLEM", "DELAY", "WAITING"].includes(String(input.kind)))) ||
    (input.path.endsWith("/comments") && input.body === undefined) ||
    (input.path.endsWith("/acknowledge") && input.body !== undefined) ||
    (input.mediaAssetIds !== undefined &&
      (!Array.isArray(input.mediaAssetIds) ||
        input.mediaAssetIds.length > 5 ||
        new Set(input.mediaAssetIds).size !== input.mediaAssetIds.length ||
        input.mediaAssetIds.some(
          (id: unknown) => typeof id !== "string" || !uuid.test(id),
        ) ||
        (input.path !== "progress" && input.path !== "issues")))
  )
    return "UNAVAILABLE";
  try {
    const csrfResponse = await input.fetch.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrfResponse.status === 401) return "AUTH_REQUIRED";
    if (!csrfResponse.ok) return "UNAVAILABLE";
    const csrf: unknown = await csrfResponse.json();
    if (
      !record(csrf) ||
      !exact(csrf, ["csrfToken"]) ||
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1_000
    )
      return "UNAVAILABLE";
    const payload =
      input.path === "issues"
        ? {
            commandId: input.commandId,
            kind: input.kind,
            body: input.body,
            ...(input.mediaAssetIds === undefined
              ? {}
              : { mediaAssetIds: input.mediaAssetIds }),
          }
        : input.body === undefined
          ? { commandId: input.commandId }
          : {
              commandId: input.commandId,
              body: input.body,
              ...(input.mediaAssetIds === undefined
                ? {}
                : { mediaAssetIds: input.mediaAssetIds }),
            };
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/${input.path}`,
      {
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.csrfToken,
        },
        method: "POST",
      },
    );
    if (response.status === 401) return "AUTH_REQUIRED";
    if (!response.ok) return "UNAVAILABLE";
    const data: unknown = await response.json();
    if (
      !record(data) ||
      (data.status !== "APPLIED" && data.status !== "DEDUPLICATED")
    )
      return "UNAVAILABLE";
    if (input.path.endsWith("/acknowledge"))
      return exact(data, ["status", "acknowledgedAt"]) &&
        iso(data.acknowledgedAt)
        ? "OK"
        : "UNAVAILABLE";
    return exact(data, ["status", "id", "createdAt"]) &&
      typeof data.id === "string" &&
      uuid.test(data.id) &&
      iso(data.createdAt)
      ? "OK"
      : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}
