const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const download =
  /^\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/download$/iu;
type Dict = Record<string, unknown>;
const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Dict, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const calendarDay = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const bounded = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length >= min &&
  value.length <= max &&
  !/[\p{Cc}]/u.test(value.replace(/[\n\t]/gu, ""));
const mediaIds = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= 10 &&
  new Set(value).size === value.length &&
  value.every((item) => typeof item === "string" && uuid.test(item));
const mediaPaths = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= 10 &&
  new Set(value).size === value.length &&
  value.every((item) => typeof item === "string" && download.test(item));

export type CompletionState =
  | "CONFIRMED"
  | "IN_PROGRESS"
  | "COMPLETION_REQUESTED"
  | "COMPLETED"
  | "CANCELLED";
export type CompletionCategory =
  "UNFINISHED_SCOPE" | "DEFECT" | "MISSING_OUTPUT" | "OTHER";
export interface CompletionAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly requestedAt: string;
  readonly note: string | null;
  readonly physicalWorkFinishedOn: string | null;
  readonly finalMediaDownloadPaths: readonly string[];
  readonly outcome: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";
  readonly decidedAt: string | null;
  readonly rejectionCategory: CompletionCategory | null;
  readonly rejectionReason: string | null;
  readonly objectionMediaDownloadPaths: readonly string[];
}
export interface CompletionPage {
  readonly jobState: CompletionState;
  readonly attempts: readonly CompletionAttempt[];
  readonly administrativeCompletion: Readonly<{
    commandId: string;
    recordedAt: string;
    reason: string;
  }> | null;
}
export type CompletionLoad =
  | { readonly status: "OK"; readonly page: CompletionPage }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

const attemptKeys = [
  "id",
  "attemptNumber",
  "requestedAt",
  "note",
  "physicalWorkFinishedOn",
  "finalMediaDownloadPaths",
  "outcome",
  "decidedAt",
  "rejectionCategory",
  "rejectionReason",
  "objectionMediaDownloadPaths",
] as const;
export function parseCompletionPage(value: unknown): CompletionPage | null {
  if (
    !record(value) ||
    !(
      exact(value, ["jobState", "attempts"]) ||
      exact(value, ["jobState", "attempts", "administrativeCompletion"])
    ) ||
    ![
      "CONFIRMED",
      "IN_PROGRESS",
      "COMPLETION_REQUESTED",
      "COMPLETED",
      "CANCELLED",
    ].includes(String(value.jobState)) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 10_000
  )
    return null;
  const administrativeCompletion = value.administrativeCompletion ?? null;
  if (
    administrativeCompletion !== null &&
    (!record(administrativeCompletion) ||
      !exact(administrativeCompletion, ["commandId", "recordedAt", "reason"]) ||
      typeof administrativeCompletion.commandId !== "string" ||
      !uuid.test(administrativeCompletion.commandId) ||
      !instant(administrativeCompletion.recordedAt) ||
      !bounded(administrativeCompletion.reason, 8, 1000))
  )
    return null;
  let pending = 0;
  let accepted = 0;
  const attempts: CompletionAttempt[] = [];
  for (const raw of value.attempts as unknown[]) {
    if (
      !record(raw) ||
      !exact(raw, attemptKeys) ||
      typeof raw.id !== "string" ||
      !uuid.test(raw.id) ||
      typeof raw.attemptNumber !== "number" ||
      !Number.isSafeInteger(raw.attemptNumber) ||
      (attempts.length > 0 &&
        raw.attemptNumber !==
          attempts[attempts.length - 1]!.attemptNumber - 1) ||
      !instant(raw.requestedAt) ||
      (raw.note !== null && !bounded(raw.note, 1, 1000)) ||
      (raw.physicalWorkFinishedOn !== null &&
        !calendarDay(raw.physicalWorkFinishedOn)) ||
      !mediaPaths(raw.finalMediaDownloadPaths) ||
      !["PENDING", "ACCEPTED", "REJECTED", "WITHDRAWN"].includes(
        String(raw.outcome),
      ) ||
      (raw.decidedAt !== null &&
        (!instant(raw.decidedAt) ||
          Date.parse(raw.decidedAt) < Date.parse(raw.requestedAt))) ||
      (raw.rejectionCategory !== null &&
        (typeof raw.rejectionCategory !== "string" ||
          !["UNFINISHED_SCOPE", "DEFECT", "MISSING_OUTPUT", "OTHER"].includes(
            raw.rejectionCategory,
          ))) ||
      (raw.rejectionReason !== null &&
        !bounded(raw.rejectionReason, 8, 1000)) ||
      !mediaPaths(raw.objectionMediaDownloadPaths) ||
      (raw.outcome === "PENDING" &&
        (raw.decidedAt !== null ||
          raw.rejectionCategory !== null ||
          raw.rejectionReason !== null ||
          raw.objectionMediaDownloadPaths.length !== 0)) ||
      (raw.outcome !== "PENDING" && raw.decidedAt === null) ||
      (raw.outcome === "REJECTED" &&
        (raw.rejectionCategory === null || raw.rejectionReason === null)) ||
      (raw.outcome === "WITHDRAWN" && raw.rejectionReason === null) ||
      (raw.outcome === "WITHDRAWN" &&
        (raw.rejectionCategory !== null ||
          raw.objectionMediaDownloadPaths.length !== 0)) ||
      (raw.outcome === "ACCEPTED" &&
        (raw.rejectionCategory !== null ||
          raw.rejectionReason !== null ||
          raw.objectionMediaDownloadPaths.length !== 0))
    )
      return null;
    if (raw.outcome === "PENDING") pending++;
    if (raw.outcome === "ACCEPTED") accepted++;
    attempts.push(raw as unknown as CompletionAttempt);
  }
  if (
    pending > 1 ||
    accepted > 1 ||
    (attempts.length > 0 && attempts.at(-1)?.attemptNumber !== 1) ||
    new Set(attempts.map((attempt) => attempt.id)).size !== attempts.length ||
    (pending === 1 &&
      ((value.jobState !== "COMPLETION_REQUESTED" &&
        !(
          value.jobState === "COMPLETED" && administrativeCompletion !== null
        )) ||
        attempts[0]?.outcome !== "PENDING")) ||
    (accepted === 1 &&
      (value.jobState !== "COMPLETED" ||
        attempts[0]?.outcome !== "ACCEPTED")) ||
    (value.jobState === "COMPLETION_REQUESTED" && pending !== 1) ||
    (value.jobState === "COMPLETED" &&
      accepted !== 1 &&
      administrativeCompletion === null) ||
    (administrativeCompletion !== null &&
      (value.jobState !== "COMPLETED" || accepted !== 0))
  )
    return null;
  return {
    jobState: value.jobState as CompletionState,
    attempts,
    administrativeCompletion:
      administrativeCompletion as CompletionPage["administrativeCompletion"],
  };
}

export async function loadCompletionPage(input: {
  fetch: typeof fetch;
  jobId: string;
}): Promise<CompletionLoad> {
  if (!uuid.test(input.jobId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/completion`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseCompletionPage(await response.json());
    return page ? { status: "OK", page } : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export type CompletionCommand =
  | {
      readonly kind: "REQUEST";
      readonly note?: string | null;
      readonly physicalWorkFinishedOn?: string | null;
      readonly finalMediaAssetIds?: readonly string[];
    }
  | { readonly kind: "ACCEPT"; readonly attemptId: string }
  | {
      readonly kind: "REJECT";
      readonly attemptId: string;
      readonly category: CompletionCategory;
      readonly reason: string;
      readonly evidenceMediaAssetIds?: readonly string[];
    }
  | {
      readonly kind: "WITHDRAW";
      readonly attemptId: string;
      readonly reason: string;
    };
export type CompletionCommandResult =
  | {
      readonly status: "OK";
      readonly jobState: CompletionState;
      readonly attemptId: string;
    }
  | {
      readonly status:
        "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";
    };

export function validCompletionCommand(command: CompletionCommand): boolean {
  if (command.kind === "REQUEST")
    return (
      (command.note === undefined ||
        command.note === null ||
        bounded(command.note, 1, 1000)) &&
      (command.physicalWorkFinishedOn === undefined ||
        command.physicalWorkFinishedOn === null ||
        calendarDay(command.physicalWorkFinishedOn)) &&
      (command.finalMediaAssetIds === undefined ||
        mediaIds(command.finalMediaAssetIds))
    );
  if (!uuid.test(command.attemptId)) return false;
  if (command.kind === "ACCEPT") return true;
  if (command.kind === "WITHDRAW") return bounded(command.reason, 8, 1000);
  return (
    ["UNFINISHED_SCOPE", "DEFECT", "MISSING_OUTPUT", "OTHER"].includes(
      command.category,
    ) &&
    bounded(command.reason, 8, 1000) &&
    (command.evidenceMediaAssetIds === undefined ||
      mediaIds(command.evidenceMediaAssetIds))
  );
}

export async function sendCompletionCommand(input: {
  fetch: typeof fetch;
  jobId: string;
  commandId: string;
  command: CompletionCommand;
}): Promise<CompletionCommandResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.commandId) ||
    !validCompletionCommand(input.command)
  )
    return { status: "UNAVAILABLE" };
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
      !bounded(csrf.csrfToken, 1, 1000)
    )
      return { status: "UNAVAILABLE" };
    const command = input.command;
    const path =
      command.kind === "REQUEST"
        ? "request"
        : `${command.attemptId}/${command.kind.toLowerCase()}`;
    const fields =
      command.kind === "REQUEST"
        ? {
            note: command.note,
            physicalWorkFinishedOn: command.physicalWorkFinishedOn,
            finalMediaAssetIds: command.finalMediaAssetIds,
          }
        : command.kind === "REJECT"
          ? {
              category: command.category,
              reason: command.reason,
              evidenceMediaAssetIds: command.evidenceMediaAssetIds,
            }
          : command.kind === "WITHDRAW"
            ? { reason: command.reason }
            : {};
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/completion/${path}`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.csrfToken,
        },
        body: JSON.stringify({ commandId: input.commandId, ...fields }),
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) return { status: "CONFLICT" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const result: unknown = await response.json();
    if (
      !record(result) ||
      !exact(result, ["status", "jobState", "attemptId", "recordedAt"]) ||
      !["APPLIED", "DEDUPLICATED"].includes(String(result.status)) ||
      !["IN_PROGRESS", "COMPLETION_REQUESTED", "COMPLETED"].includes(
        String(result.jobState),
      ) ||
      typeof result.attemptId !== "string" ||
      !uuid.test(result.attemptId) ||
      !instant(result.recordedAt)
    )
      return { status: "UNAVAILABLE" };
    return {
      status: "OK",
      jobState: result.jobState as CompletionState,
      attemptId: result.attemptId,
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
