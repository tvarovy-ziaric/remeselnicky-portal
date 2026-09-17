const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const day = /^\d{4}-\d{2}-\d{2}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const download =
  /^\/v1\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/download$/iu;
type Dict = Record<string, unknown>;
const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Dict, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, max: number, min = 1): value is string =>
  typeof value === "string" &&
  value.trim().length >= min &&
  value.length <= max &&
  !/[\p{Cc}]/u.test(value.replace(/[\n\t]/gu, ""));
const nullableText = (value: unknown, max: number) =>
  value === null || text(value, max);
const date = (value: unknown): value is string => {
  if (typeof value !== "string" || !day.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};
const nullableDate = (value: unknown): value is string | null =>
  value === null || date(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  instant.test(value) &&
  Number.isFinite(Date.parse(value));
const nullableTimestamp = (value: unknown): value is string | null =>
  value === null || timestamp(value);
const nullableUuid = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && uuid.test(value));
const datesOrdered = (start: string | null, end: string | null) =>
  start === null || end === null || start <= end;

export interface MilestoneContextCursor {
  readonly beforeAt: string;
  readonly beforeId: string;
}
export interface MilestoneContextPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: MilestoneContextCursor | null;
}
export interface MilestoneProposal {
  readonly id: string;
  readonly jobId: string;
  readonly targetMilestoneId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
  readonly createdAt: string;
  readonly decision: "ACCEPT" | "DECLINE" | null;
  readonly decidedAt: string | null;
  readonly appliedMilestoneId: string | null;
  readonly canDecide: boolean;
}
export interface MilestoneComment {
  readonly id: string;
  readonly milestoneId: string;
  readonly authorRole: "CUSTOMER" | "PRIMARY_PROVIDER" | "PARTICIPANT";
  readonly body: string;
  readonly createdAt: string;
}
export interface MilestoneMedia {
  readonly id: string;
  readonly milestoneId: string;
  readonly mediaAssetId: string;
  readonly kind: "PHOTO" | "DOCUMENT";
  readonly sourceMessageId: string;
  readonly uploadedByUserId: string;
  readonly uploadedAt: string;
  readonly capturedAt: string | null;
  readonly displayFilename: string | null;
  readonly contentType: string;
  readonly downloadPath: string;
  readonly linkedAt: string;
}
export type MilestoneContextLoad<T> =
  | { readonly status: "OK"; readonly value: T }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

const proposalKeys = [
  "id",
  "jobId",
  "targetMilestoneId",
  "title",
  "description",
  "plannedStartOn",
  "plannedEndOn",
  "createdAt",
  "decision",
  "decidedAt",
  "appliedMilestoneId",
  "canDecide",
] as const;
const commentKeys = [
  "id",
  "milestoneId",
  "authorRole",
  "body",
  "createdAt",
] as const;
const mediaKeys = [
  "id",
  "milestoneId",
  "mediaAssetId",
  "kind",
  "sourceMessageId",
  "uploadedByUserId",
  "uploadedAt",
  "capturedAt",
  "displayFilename",
  "contentType",
  "downloadPath",
  "linkedAt",
] as const;

function parseProposal(
  value: unknown,
  jobId: string,
): MilestoneProposal | null {
  if (
    !record(value) ||
    !exact(value, proposalKeys) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    value.jobId !== jobId ||
    !nullableUuid(value.targetMilestoneId) ||
    !text(value.title, 160) ||
    !nullableText(value.description, 2_000) ||
    !nullableDate(value.plannedStartOn) ||
    !nullableDate(value.plannedEndOn) ||
    !datesOrdered(value.plannedStartOn, value.plannedEndOn) ||
    !timestamp(value.createdAt) ||
    ![null, "ACCEPT", "DECLINE"].includes(value.decision as null | string) ||
    !nullableTimestamp(value.decidedAt) ||
    !nullableUuid(value.appliedMilestoneId) ||
    typeof value.canDecide !== "boolean" ||
    (value.decision === null &&
      (value.decidedAt !== null || value.appliedMilestoneId !== null)) ||
    (value.decision !== null &&
      (value.decidedAt === null ||
        Date.parse(value.decidedAt) < Date.parse(value.createdAt) ||
        value.canDecide)) ||
    (value.decision === "DECLINE" && value.appliedMilestoneId !== null) ||
    (value.decision === "ACCEPT" && value.appliedMilestoneId === null)
  )
    return null;
  return value as unknown as MilestoneProposal;
}
function parseComment(
  value: unknown,
  milestoneId: string,
): MilestoneComment | null {
  if (
    !record(value) ||
    !exact(value, commentKeys) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    value.milestoneId !== milestoneId ||
    !["CUSTOMER", "PRIMARY_PROVIDER", "PARTICIPANT"].includes(
      String(value.authorRole),
    ) ||
    !text(value.body, 2_000) ||
    !timestamp(value.createdAt)
  )
    return null;
  return value as unknown as MilestoneComment;
}
function parseMedia(
  value: unknown,
  milestoneId: string,
): MilestoneMedia | null {
  if (
    !record(value) ||
    !exact(value, mediaKeys) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    value.milestoneId !== milestoneId ||
    typeof value.mediaAssetId !== "string" ||
    !uuid.test(value.mediaAssetId) ||
    !["PHOTO", "DOCUMENT"].includes(String(value.kind)) ||
    typeof value.sourceMessageId !== "string" ||
    !uuid.test(value.sourceMessageId) ||
    typeof value.uploadedByUserId !== "string" ||
    !uuid.test(value.uploadedByUserId) ||
    !timestamp(value.uploadedAt) ||
    !nullableTimestamp(value.capturedAt) ||
    (value.displayFilename !== null && !text(value.displayFilename, 255)) ||
    typeof value.contentType !== "string" ||
    (value.kind === "PHOTO" &&
      !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(
        value.contentType,
      )) ||
    (value.kind === "DOCUMENT" && value.contentType !== "application/pdf") ||
    typeof value.downloadPath !== "string" ||
    download.exec(value.downloadPath)?.[1]?.toLowerCase() !==
      value.mediaAssetId.toLowerCase() ||
    !timestamp(value.linkedAt) ||
    Date.parse(value.linkedAt) < Date.parse(value.uploadedAt)
  )
    return null;
  return value as unknown as MilestoneMedia;
}
function parsePage<T extends { readonly id: string }>(
  value: unknown,
  item: (raw: unknown) => T | null,
  time: (value: T) => string,
): MilestoneContextPage<T> | null {
  if (
    !record(value) ||
    !exact(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 20
  )
    return null;
  const items: T[] = [];
  const ids = new Set<string>();
  for (const raw of value.items as unknown[]) {
    const parsed = item(raw);
    if (!parsed) return null;
    const id = parsed.id;
    const at = time(parsed);
    if (
      ids.has(id) ||
      (items.length > 0 &&
        (at > time(items[items.length - 1]!) ||
          (at === time(items[items.length - 1]!) &&
            id >= items[items.length - 1]!.id)))
    )
      return null;
    ids.add(id);
    items.push(parsed);
  }
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (!record(cursor) ||
      !exact(cursor, ["beforeAt", "beforeId"]) ||
      !timestamp(cursor.beforeAt) ||
      typeof cursor.beforeId !== "string" ||
      !uuid.test(cursor.beforeId) ||
      items.length === 0 ||
      cursor.beforeAt !== time(items[items.length - 1]!) ||
      cursor.beforeId !== items[items.length - 1]!.id)
  )
    return null;
  return { items, nextCursor: cursor as MilestoneContextCursor | null };
}
export const parseMilestoneProposalPage = (value: unknown, jobId: string) =>
  uuid.test(jobId)
    ? parsePage(
        value,
        (raw) => parseProposal(raw, jobId),
        (item) => item.createdAt,
      )
    : null;
export const parseMilestoneCommentPage = (
  value: unknown,
  milestoneId: string,
) =>
  uuid.test(milestoneId)
    ? parsePage(
        value,
        (raw) => parseComment(raw, milestoneId),
        (item) => item.createdAt,
      )
    : null;
export const parseMilestoneMediaPage = (value: unknown, milestoneId: string) =>
  uuid.test(milestoneId)
    ? parsePage(
        value,
        (raw) => parseMedia(raw, milestoneId),
        (item) => item.linkedAt,
      )
    : null;
export const parseMilestoneProposal = parseProposal;

type Collection = "proposals" | "comments" | "media";
export async function loadMilestoneContextPage(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly collection: Collection;
  readonly milestoneId?: string;
  readonly cursor?: MilestoneContextCursor | null;
}): Promise<
  MilestoneContextLoad<
    MilestoneContextPage<MilestoneProposal | MilestoneComment | MilestoneMedia>
  >
> {
  if (
    !uuid.test(input.jobId) ||
    (input.collection !== "proposals" &&
      (typeof input.milestoneId !== "string" ||
        !uuid.test(input.milestoneId))) ||
    (input.cursor != null &&
      (!timestamp(input.cursor.beforeAt) || !uuid.test(input.cursor.beforeId)))
  )
    return { status: "UNAVAILABLE" };
  const path =
    input.collection === "proposals"
      ? `/v1/me/jobs/${input.jobId}/milestone-proposals`
      : `/v1/me/jobs/${input.jobId}/milestones/${input.milestoneId}/${input.collection}`;
  const query = new URLSearchParams({ limit: "20" });
  if (input.cursor) {
    query.set("beforeAt", input.cursor.beforeAt);
    query.set("beforeId", input.cursor.beforeId);
  }
  try {
    const response = await input.fetch.call(globalThis, `${path}?${query}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const raw: unknown = await response.json();
    const page =
      input.collection === "proposals"
        ? parseMilestoneProposalPage(raw, input.jobId)
        : input.collection === "comments"
          ? parseMilestoneCommentPage(raw, input.milestoneId!)
          : parseMilestoneMediaPage(raw, input.milestoneId!);
    if (
      !page ||
      (input.cursor &&
        page.items.some((entry) => {
          const at =
            input.collection === "media"
              ? (entry as MilestoneMedia).linkedAt
              : (entry as MilestoneProposal | MilestoneComment).createdAt;
          return (
            at > input.cursor!.beforeAt ||
            (at === input.cursor!.beforeAt &&
              entry.id >= input.cursor!.beforeId)
          );
        }))
    )
      return { status: "UNAVAILABLE" };
    return { status: "OK", value: page };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function loadMilestoneProposal(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly proposalId: string;
}): Promise<MilestoneContextLoad<MilestoneProposal>> {
  if (!uuid.test(input.jobId) || !uuid.test(input.proposalId))
    return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/milestone-proposals/${input.proposalId}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const item = parseProposal((await response.json()) as unknown, input.jobId);
    return item?.id === input.proposalId
      ? { status: "OK", value: item }
      : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export type MilestoneContextCommand =
  | {
      readonly kind: "PROPOSAL";
      readonly title: string;
      readonly description?: string | null;
      readonly plannedStartOn?: string | null;
      readonly plannedEndOn?: string | null;
      readonly targetMilestoneId?: string | null;
    }
  | {
      readonly kind: "DECISION";
      readonly proposalId: string;
      readonly decision: "ACCEPT" | "DECLINE";
    }
  | {
      readonly kind: "COMMENT";
      readonly milestoneId: string;
      readonly body: string;
    }
  | {
      readonly kind: "MEDIA";
      readonly milestoneId: string;
      readonly mediaAssetId: string;
    };
export type MilestoneContextCommandResult =
  | {
      readonly status: "OK";
      readonly id: string;
      readonly appliedMilestoneId: string | null;
    }
  | {
      readonly status:
        "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";
    };

export function validMilestoneContextCommand(
  command: MilestoneContextCommand,
): boolean {
  if (command.kind === "PROPOSAL")
    return (
      text(command.title, 160) &&
      (command.description === undefined ||
        command.description === null ||
        text(command.description, 2_000)) &&
      (command.plannedStartOn === undefined ||
        nullableDate(command.plannedStartOn)) &&
      (command.plannedEndOn === undefined ||
        nullableDate(command.plannedEndOn)) &&
      datesOrdered(
        command.plannedStartOn ?? null,
        command.plannedEndOn ?? null,
      ) &&
      (command.targetMilestoneId === undefined ||
        nullableUuid(command.targetMilestoneId))
    );
  if (command.kind === "DECISION")
    return (
      uuid.test(command.proposalId) &&
      ["ACCEPT", "DECLINE"].includes(command.decision)
    );
  if (command.kind === "COMMENT")
    return uuid.test(command.milestoneId) && text(command.body, 2_000);
  return uuid.test(command.milestoneId) && uuid.test(command.mediaAssetId);
}
export async function sendMilestoneContextCommand(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly commandId: string;
  readonly command: MilestoneContextCommand;
}): Promise<MilestoneContextCommandResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.commandId) ||
    !validMilestoneContextCommand(input.command)
  )
    return { status: "UNAVAILABLE" };
  const action = input.command;
  const path =
    action.kind === "PROPOSAL"
      ? `/v1/me/jobs/${input.jobId}/milestone-proposals`
      : action.kind === "DECISION"
        ? `/v1/me/jobs/${input.jobId}/milestone-proposals/${action.proposalId}/decision`
        : `/v1/me/jobs/${input.jobId}/milestones/${action.milestoneId}/${action.kind === "COMMENT" ? "comments" : "media"}`;
  const { kind, ...body } = action;
  void kind;
  const payload = { commandId: input.commandId, ...body } as Dict;
  delete payload.milestoneId;
  delete payload.proposalId;
  try {
    const csrfResponse = await input.fetch.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrfResponse.status === 401) return { status: "AUTH_REQUIRED" };
    if (!csrfResponse.ok) return { status: "UNAVAILABLE" };
    const csrf: unknown = await csrfResponse.json();
    if (
      !record(csrf) ||
      !exact(csrf, ["csrfToken"]) ||
      !text(csrf.csrfToken, 1_000)
    )
      return { status: "UNAVAILABLE" };
    const response = await input.fetch.call(globalThis, path, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrf.csrfToken,
      },
      body: JSON.stringify(payload),
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) return { status: "CONFLICT" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const data: unknown = await response.json();
    if (
      !record(data) ||
      !["APPLIED", "DEDUPLICATED"].includes(String(data.status)) ||
      data.id !== input.commandId ||
      (Object.keys(data).length !== 2 && Object.keys(data).length !== 3) ||
      (Object.keys(data).length === 2 && !exact(data, ["status", "id"])) ||
      (Object.keys(data).length === 3 &&
        !exact(data, ["status", "id", "appliedMilestoneId"])) ||
      (Object.hasOwn(data, "appliedMilestoneId") &&
        !nullableUuid(data.appliedMilestoneId))
    )
      return { status: "UNAVAILABLE" };
    return {
      status: "OK",
      id: input.commandId,
      appliedMilestoneId: Object.hasOwn(data, "appliedMilestoneId")
        ? (data.appliedMilestoneId as string | null)
        : null,
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
