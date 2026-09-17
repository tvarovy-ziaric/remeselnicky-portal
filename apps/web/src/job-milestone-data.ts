const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const calendarDate = /^\d{4}-\d{2}-\d{2}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const download =
  /^\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/download$/iu;
type Dict = Record<string, unknown>;
const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Dict, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const date = (value: unknown): value is string => {
  if (typeof value !== "string" || !calendarDate.test(value)) return false;
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
const bounded = (value: unknown, max: number, min = 0): value is string =>
  typeof value === "string" &&
  value.trim().length >= min &&
  value.length <= max &&
  !/[\p{Cc}]/u.test(value.replace(/[\n\t]/gu, ""));
const nullableBounded = (value: unknown, max: number): value is string | null =>
  value === null || bounded(value, max);
const range = (start: string | null, end: string | null): boolean =>
  start === null || end === null || start <= end;

export type MilestoneState = "PLANNED" | "IN_PROGRESS" | "DONE" | "SKIPPED";
export interface MilestoneResponsibility {
  readonly kind: "PARTICIPANT" | "WORK_GROUP";
  readonly id: string;
}
export interface MilestoneCapabilities {
  readonly canEdit: boolean;
  readonly canSetState: boolean;
  readonly canMarkDone: boolean;
  readonly canReorder: boolean;
  readonly canAssign: boolean;
  readonly canAcknowledge: boolean;
}
export interface MilestoneItem {
  readonly id: string;
  readonly jobId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: MilestoneState;
  readonly orderIndex: number;
  readonly originalPlannedStartOn: string | null;
  readonly originalPlannedEndOn: string | null;
  readonly currentPlannedStartOn: string | null;
  readonly currentPlannedEndOn: string | null;
  readonly acceptedStageLabel: string | null;
  readonly sourceQuoteId: string | null;
  readonly sourceQuoteRevision: number | null;
  readonly sourcePdfDownloadPath: string | null;
  readonly sourceChangeOrderRevisionId: string | null;
  readonly responsibility: MilestoneResponsibility | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acknowledgedAt: string | null;
  readonly capabilities: MilestoneCapabilities;
}
export interface MilestoneCursor {
  readonly afterOrder: number;
  readonly afterId: string;
}
export interface MilestonePage {
  readonly items: readonly MilestoneItem[];
  readonly canCreate: boolean;
  readonly nextCursor: MilestoneCursor | null;
}
export interface MilestoneHistoryItem {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: "CREATE" | "EDIT" | "STATE" | "REORDER" | "ASSIGN";
  readonly actorUserId: string;
  readonly title: string;
  readonly description: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
  readonly state: MilestoneState;
  readonly orderKey: string;
  readonly responsibility: MilestoneResponsibility | null;
  readonly acceptedStageLabel: string | null;
  readonly sourceQuoteId: string | null;
  readonly sourceQuoteRevision: number | null;
  readonly sourcePdfDownloadPath: string | null;
  readonly sourceChangeOrderRevisionId: string | null;
  readonly recordedAt: string;
}
export interface MilestoneHistoryPage {
  readonly items: readonly MilestoneHistoryItem[];
  readonly nextCursor: number | null;
}
export type MilestoneLoad<T> =
  | { readonly status: "OK"; readonly value: T }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

const itemKeys = [
  "id",
  "jobId",
  "title",
  "description",
  "state",
  "orderIndex",
  "originalPlannedStartOn",
  "originalPlannedEndOn",
  "currentPlannedStartOn",
  "currentPlannedEndOn",
  "acceptedStageLabel",
  "sourceQuoteId",
  "sourceQuoteRevision",
  "sourcePdfDownloadPath",
  "sourceChangeOrderRevisionId",
  "responsibility",
  "createdAt",
  "updatedAt",
  "acknowledgedAt",
  "capabilities",
] as const;
const capabilityKeys = [
  "canEdit",
  "canSetState",
  "canMarkDone",
  "canReorder",
  "canAssign",
  "canAcknowledge",
] as const;

export function parseMilestoneItem(
  value: unknown,
  jobId: string,
): MilestoneItem | null {
  if (
    !record(value) ||
    !exact(value, itemKeys) ||
    !uuid.test(jobId) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    value.jobId !== jobId ||
    !bounded(value.title, 160, 1) ||
    !nullableBounded(value.description, 2_000) ||
    !["PLANNED", "IN_PROGRESS", "DONE", "SKIPPED"].includes(
      String(value.state),
    ) ||
    typeof value.orderIndex !== "number" ||
    !Number.isSafeInteger(value.orderIndex) ||
    value.orderIndex < 0 ||
    !nullableDate(value.originalPlannedStartOn) ||
    !nullableDate(value.originalPlannedEndOn) ||
    !nullableDate(value.currentPlannedStartOn) ||
    !nullableDate(value.currentPlannedEndOn) ||
    !range(value.originalPlannedStartOn, value.originalPlannedEndOn) ||
    !range(value.currentPlannedStartOn, value.currentPlannedEndOn) ||
    !nullableBounded(value.acceptedStageLabel, 160) ||
    (value.sourceQuoteId !== null &&
      (typeof value.sourceQuoteId !== "string" ||
        !uuid.test(value.sourceQuoteId))) ||
    (value.sourceQuoteRevision !== null &&
      (typeof value.sourceQuoteRevision !== "number" ||
        !Number.isSafeInteger(value.sourceQuoteRevision) ||
        value.sourceQuoteRevision < 1)) ||
    (value.sourcePdfDownloadPath !== null &&
      (typeof value.sourcePdfDownloadPath !== "string" ||
        !download.test(value.sourcePdfDownloadPath))) ||
    (value.sourceChangeOrderRevisionId !== null &&
      (typeof value.sourceChangeOrderRevisionId !== "string" ||
        !uuid.test(value.sourceChangeOrderRevisionId))) ||
    (value.acceptedStageLabel === null &&
      (value.sourceQuoteId !== null ||
        value.sourceQuoteRevision !== null ||
        value.sourcePdfDownloadPath !== null)) ||
    (value.acceptedStageLabel !== null &&
      (value.sourceQuoteId === null || value.sourceQuoteRevision === null)) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    !nullableTimestamp(value.acknowledgedAt) ||
    (value.acknowledgedAt !== null &&
      Date.parse(value.acknowledgedAt) < Date.parse(value.createdAt)) ||
    !record(value.capabilities) ||
    !exact(value.capabilities, capabilityKeys) ||
    !capabilityKeys.every(
      (key) => typeof (value.capabilities as Dict)[key] === "boolean",
    ) ||
    (value.capabilities.canMarkDone === true &&
      value.capabilities.canSetState !== true)
  )
    return null;
  if (
    value.responsibility !== null &&
    (!record(value.responsibility) ||
      !exact(value.responsibility, ["kind", "id"]) ||
      !["PARTICIPANT", "WORK_GROUP"].includes(
        String(value.responsibility.kind),
      ) ||
      typeof value.responsibility.id !== "string" ||
      !uuid.test(value.responsibility.id))
  )
    return null;
  return value as unknown as MilestoneItem;
}

export function parseMilestonePage(
  value: unknown,
  jobId: string,
): MilestonePage | null {
  if (
    !record(value) ||
    !exact(value, ["items", "canCreate", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    typeof value.canCreate !== "boolean"
  )
    return null;
  const items: MilestoneItem[] = [];
  const ids = new Set<string>();
  for (const raw of value.items as unknown[]) {
    const item = parseMilestoneItem(raw, jobId);
    if (
      !item ||
      ids.has(item.id) ||
      (items.length > 0 &&
        (item.orderIndex < items[items.length - 1]!.orderIndex ||
          (item.orderIndex === items[items.length - 1]!.orderIndex &&
            item.id <= items[items.length - 1]!.id)))
    )
      return null;
    ids.add(item.id);
    items.push(item);
  }
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (!record(cursor) ||
      !exact(cursor, ["afterOrder", "afterId"]) ||
      typeof cursor.afterOrder !== "number" ||
      !Number.isSafeInteger(cursor.afterOrder) ||
      cursor.afterOrder < 0 ||
      typeof cursor.afterId !== "string" ||
      !uuid.test(cursor.afterId) ||
      items.at(-1)?.orderIndex !== cursor.afterOrder ||
      items.at(-1)?.id !== cursor.afterId)
  )
    return null;
  return {
    items,
    canCreate: value.canCreate,
    nextCursor: cursor as MilestoneCursor | null,
  };
}

const historyKeys = [
  "eventId",
  "sequence",
  "kind",
  "actorUserId",
  "title",
  "description",
  "plannedStartOn",
  "plannedEndOn",
  "state",
  "orderKey",
  "responsibility",
  "acceptedStageLabel",
  "sourceQuoteId",
  "sourceQuoteRevision",
  "sourcePdfDownloadPath",
  "sourceChangeOrderRevisionId",
  "recordedAt",
] as const;

export function parseMilestoneHistoryPage(
  value: unknown,
): MilestoneHistoryPage | null {
  if (
    !record(value) ||
    !exact(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 20
  )
    return null;
  const ids = new Set<string>();
  const items: MilestoneHistoryItem[] = [];
  for (const raw of value.items as unknown[]) {
    if (
      !record(raw) ||
      !exact(raw, historyKeys) ||
      typeof raw.eventId !== "string" ||
      !uuid.test(raw.eventId) ||
      ids.has(raw.eventId) ||
      typeof raw.sequence !== "number" ||
      !Number.isSafeInteger(raw.sequence) ||
      raw.sequence < 1 ||
      (items.length > 0 && raw.sequence >= items[items.length - 1]!.sequence) ||
      !["CREATE", "EDIT", "STATE", "REORDER", "ASSIGN"].includes(
        String(raw.kind),
      ) ||
      (raw.kind === "CREATE" && raw.sequence !== 1) ||
      typeof raw.actorUserId !== "string" ||
      !uuid.test(raw.actorUserId) ||
      !bounded(raw.title, 160, 1) ||
      !nullableBounded(raw.description, 2_000) ||
      !nullableDate(raw.plannedStartOn) ||
      !nullableDate(raw.plannedEndOn) ||
      !range(raw.plannedStartOn, raw.plannedEndOn) ||
      !["PLANNED", "IN_PROGRESS", "DONE", "SKIPPED"].includes(
        String(raw.state),
      ) ||
      typeof raw.orderKey !== "string" ||
      raw.orderKey.length > 42 ||
      !/^-?\d{1,20}(?:\.\d{1,20})?$/u.test(raw.orderKey) ||
      !nullableBounded(raw.acceptedStageLabel, 160) ||
      (raw.sourceQuoteId !== null &&
        (typeof raw.sourceQuoteId !== "string" ||
          !uuid.test(raw.sourceQuoteId))) ||
      (raw.sourceQuoteRevision !== null &&
        (typeof raw.sourceQuoteRevision !== "number" ||
          !Number.isSafeInteger(raw.sourceQuoteRevision) ||
          raw.sourceQuoteRevision < 1)) ||
      (raw.sourcePdfDownloadPath !== null &&
        (typeof raw.sourcePdfDownloadPath !== "string" ||
          !download.test(raw.sourcePdfDownloadPath))) ||
      (raw.sourceChangeOrderRevisionId !== null &&
        (typeof raw.sourceChangeOrderRevisionId !== "string" ||
          !uuid.test(raw.sourceChangeOrderRevisionId))) ||
      (raw.acceptedStageLabel === null &&
        (raw.sourceQuoteId !== null ||
          raw.sourceQuoteRevision !== null ||
          raw.sourcePdfDownloadPath !== null)) ||
      (raw.acceptedStageLabel !== null &&
        (raw.sourceQuoteId === null || raw.sourceQuoteRevision === null)) ||
      !timestamp(raw.recordedAt)
    )
      return null;
    if (
      raw.responsibility !== null &&
      (!record(raw.responsibility) ||
        !exact(raw.responsibility, ["kind", "id"]) ||
        !["PARTICIPANT", "WORK_GROUP"].includes(
          String(raw.responsibility.kind),
        ) ||
        typeof raw.responsibility.id !== "string" ||
        !uuid.test(raw.responsibility.id))
    )
      return null;
    ids.add(raw.eventId);
    items.push(raw as unknown as MilestoneHistoryItem);
  }
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (typeof cursor !== "number" ||
      !Number.isSafeInteger(cursor) ||
      cursor < 1 ||
      items.at(-1)?.sequence !== cursor)
  )
    return null;
  return { items, nextCursor: cursor };
}

async function getJson(input: {
  fetch: typeof fetch;
  path: string;
}): Promise<MilestoneLoad<unknown>> {
  try {
    const response = await input.fetch.call(globalThis, input.path, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    return { status: "OK", value: (await response.json()) as unknown };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function loadMilestonePage(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly cursor?: MilestoneCursor | null;
}): Promise<MilestoneLoad<MilestonePage>> {
  if (
    !uuid.test(input.jobId) ||
    (input.cursor != null &&
      (!Number.isSafeInteger(input.cursor.afterOrder) ||
        input.cursor.afterOrder < 0 ||
        !uuid.test(input.cursor.afterId)))
  )
    return { status: "UNAVAILABLE" };
  const query = new URLSearchParams({ limit: "20" });
  if (input.cursor) {
    query.set("afterOrder", String(input.cursor.afterOrder));
    query.set("afterId", input.cursor.afterId);
  }
  const result = await getJson({
    fetch: input.fetch,
    path: `/v1/me/jobs/${input.jobId}/milestones?${query}`,
  });
  if (result.status !== "OK") return result;
  const page = parseMilestonePage(result.value, input.jobId);
  return page ? { status: "OK", value: page } : { status: "UNAVAILABLE" };
}

export async function loadMilestone(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly milestoneId: string;
}): Promise<MilestoneLoad<MilestoneItem>> {
  if (!uuid.test(input.jobId) || !uuid.test(input.milestoneId))
    return { status: "UNAVAILABLE" };
  const result = await getJson({
    fetch: input.fetch,
    path: `/v1/me/jobs/${input.jobId}/milestones/${input.milestoneId}`,
  });
  if (result.status !== "OK") return result;
  const item = parseMilestoneItem(result.value, input.jobId);
  return item?.id === input.milestoneId
    ? { status: "OK", value: item }
    : { status: "UNAVAILABLE" };
}

export async function loadMilestoneHistory(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly milestoneId: string;
  readonly beforeSequence?: number | null;
}): Promise<MilestoneLoad<MilestoneHistoryPage>> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.milestoneId) ||
    (input.beforeSequence != null &&
      (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1))
  )
    return { status: "UNAVAILABLE" };
  const query = new URLSearchParams({ limit: "20" });
  if (input.beforeSequence != null)
    query.set("beforeSequence", String(input.beforeSequence));
  const result = await getJson({
    fetch: input.fetch,
    path: `/v1/me/jobs/${input.jobId}/milestones/${input.milestoneId}/history?${query}`,
  });
  if (result.status !== "OK") return result;
  const page = parseMilestoneHistoryPage(result.value);
  const beforeSequence = input.beforeSequence;
  return page &&
    (beforeSequence == null ||
      page.items.every((item) => item.sequence < beforeSequence))
    ? { status: "OK", value: page }
    : { status: "UNAVAILABLE" };
}

export type MilestoneCommand =
  | {
      readonly kind: "CREATE";
      readonly title: string;
      readonly description?: string | null;
      readonly plannedStartOn?: string | null;
      readonly plannedEndOn?: string | null;
      readonly acceptedStageLabel?: string | null;
      readonly sourceChangeOrderRevisionId?: string | null;
      readonly responsibility?: MilestoneResponsibility | null;
    }
  | {
      readonly kind: "EDIT";
      readonly milestoneId: string;
      readonly title: string;
      readonly description?: string | null;
      readonly plannedStartOn?: string | null;
      readonly plannedEndOn?: string | null;
      readonly sourceChangeOrderRevisionId?: string | null;
    }
  | {
      readonly kind: "STATE";
      readonly milestoneId: string;
      readonly state: MilestoneState;
    }
  | {
      readonly kind: "REORDER";
      readonly milestoneId: string;
      readonly afterMilestoneId: string | null;
    }
  | {
      readonly kind: "ASSIGN";
      readonly milestoneId: string;
      readonly responsibility: MilestoneResponsibility | null;
    }
  | { readonly kind: "ACKNOWLEDGE"; readonly milestoneId: string };

export function validMilestoneCommand(command: MilestoneCommand): boolean {
  if (command.kind === "CREATE" || command.kind === "EDIT") {
    if (
      !bounded(command.title, 160, 1) ||
      (command.description !== undefined &&
        command.description !== null &&
        !bounded(command.description, 2_000, 1)) ||
      (command.plannedStartOn !== undefined &&
        !nullableDate(command.plannedStartOn)) ||
      (command.plannedEndOn !== undefined &&
        !nullableDate(command.plannedEndOn)) ||
      !range(command.plannedStartOn ?? null, command.plannedEndOn ?? null)
    )
      return false;
    if (
      command.kind === "CREATE" &&
      command.acceptedStageLabel !== undefined &&
      command.acceptedStageLabel !== null &&
      !bounded(command.acceptedStageLabel, 160, 1)
    )
      return false;
    if (
      command.sourceChangeOrderRevisionId !== undefined &&
      command.sourceChangeOrderRevisionId !== null &&
      !uuid.test(command.sourceChangeOrderRevisionId)
    )
      return false;
  }
  if (command.kind !== "CREATE" && !uuid.test(command.milestoneId))
    return false;
  if (
    command.kind === "STATE" &&
    !["PLANNED", "IN_PROGRESS", "DONE", "SKIPPED"].includes(command.state)
  )
    return false;
  if (
    command.kind === "REORDER" &&
    command.afterMilestoneId !== null &&
    (!uuid.test(command.afterMilestoneId) ||
      command.afterMilestoneId === command.milestoneId)
  )
    return false;
  const responsibility =
    command.kind === "ASSIGN"
      ? command.responsibility
      : command.kind === "CREATE"
        ? command.responsibility
        : undefined;
  if (
    responsibility !== undefined &&
    responsibility !== null &&
    (!record(responsibility) ||
      !exact(responsibility, ["kind", "id"]) ||
      !["PARTICIPANT", "WORK_GROUP"].includes(responsibility.kind) ||
      typeof responsibility.id !== "string" ||
      !uuid.test(responsibility.id))
  )
    return false;
  return true;
}

export type MilestoneCommandResult =
  | { readonly status: "OK"; readonly milestoneId: string }
  | {
      readonly status:
        "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";
    };

export async function sendMilestoneCommand(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly commandId: string;
  readonly command: MilestoneCommand;
}): Promise<MilestoneCommandResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.commandId) ||
    !validMilestoneCommand(input.command)
  )
    return { status: "UNAVAILABLE" };
  const { kind, ...body } = input.command;
  const suffix =
    kind === "CREATE"
      ? ""
      : `/${input.command.milestoneId}/${kind.toLowerCase()}`;
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
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1_000
    )
      return { status: "UNAVAILABLE" };
    const payload = { commandId: input.commandId, ...body };
    if (kind !== "CREATE") delete (payload as Dict).milestoneId;
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/milestones${suffix}`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.csrfToken,
        },
        body: JSON.stringify(payload),
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) return { status: "CONFLICT" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const data: unknown = await response.json();
    if (
      !record(data) ||
      !exact(data, ["status", "milestoneId"]) ||
      !["APPLIED", "DEDUPLICATED"].includes(String(data.status)) ||
      typeof data.milestoneId !== "string" ||
      !uuid.test(data.milestoneId) ||
      (kind !== "CREATE" && data.milestoneId !== input.command.milestoneId)
    )
      return { status: "UNAVAILABLE" };
    return { status: "OK", milestoneId: data.milestoneId };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
