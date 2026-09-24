import { isPublicDisplayTextSafe } from "@portal/domain";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const control = /[\p{Cc}]/u;
type Dict = Record<string, unknown>;
const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Dict, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export type ModerationReportTargetType =
  "MAIN_REVIEW" | "REVIEW_RESPONSE" | "SUPERVISOR_EVALUATION";
export type ModerationReportReason =
  | "PERSONAL_DATA_PRIVACY"
  | "HARASSMENT_ABUSE"
  | "EXTORTION_RETALIATION"
  | "IRRELEVANT_CONTENT"
  | "SUSPECTED_FRAUD_FAKE_REVIEW"
  | "OTHER";

export const moderationReportReasons = Object.freeze([
  ["PERSONAL_DATA_PRIVACY", "Osobné údaje alebo súkromie"],
  ["HARASSMENT_ABUSE", "Urážky alebo obťažovanie"],
  ["EXTORTION_RETALIATION", "Nátlak, vydieranie alebo odveta"],
  ["IRRELEVANT_CONTENT", "Nesúvisiaci obsah"],
  ["SUSPECTED_FRAUD_FAKE_REVIEW", "Podozrenie na podvodné hodnotenie"],
  ["OTHER", "Iný dôvod"],
] as const satisfies readonly (readonly [ModerationReportReason, string])[]);

export interface OwnerReviewResponse {
  readonly responseId: string;
  readonly reviewId: string;
  readonly revisionId: string;
  readonly version: number;
  readonly body: string;
  readonly respondedAt: string;
  readonly revisedAt: string;
  readonly editDeadline: string;
}

export type OwnerReviewResponseLoad =
  | { readonly status: "OK"; readonly response: OwnerReviewResponse }
  | { readonly status: "NONE" | "AUTH_REQUIRED" | "UNAVAILABLE" };

export async function loadOwnerReviewResponse(input: {
  readonly fetch: typeof fetch;
  readonly reviewId: string;
}): Promise<OwnerReviewResponseLoad> {
  if (!uuid.test(input.reviewId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/reviews/${input.reviewId}/response`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NONE" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const parsed = parseOwnerResponse(await response.json(), input.reviewId);
    return parsed === null
      ? { status: "UNAVAILABLE" }
      : { status: "OK", response: parsed };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export type ReviewResponseSubmit =
  | { readonly status: "OK"; readonly version: number }
  | {
      readonly status:
        | "AUTH_REQUIRED"
        | "NOT_FOUND"
        | "EDIT_LOCKED"
        | "CONFLICT"
        | "UNAVAILABLE";
    };

export async function submitOwnerReviewResponse(input: {
  readonly fetch: typeof fetch;
  readonly reviewId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly body: string;
}): Promise<ReviewResponseSubmit> {
  if (
    !uuid.test(input.reviewId) ||
    !uuid.test(input.commandId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.body.length > 2_000 ||
    !isPublicDisplayTextSafe(input.body)
  ) {
    return { status: "UNAVAILABLE" };
  }
  const csrfResult = await csrf(input.fetch);
  if (csrfResult.status !== "OK") return { status: csrfResult.status };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/reviews/${input.reviewId}/response`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrfResult.token,
        },
        body: JSON.stringify({
          body: input.body,
          commandId: input.commandId,
          expectedVersion: input.expectedVersion,
        }),
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) {
      const conflict: unknown = await response.json();
      if (!record(conflict) || !exact(conflict, ["code"]))
        return { status: "UNAVAILABLE" };
      if (conflict.code === "EDIT_LOCKED") return { status: "EDIT_LOCKED" };
      if (
        conflict.code === "STALE_VERSION" ||
        conflict.code === "IDEMPOTENCY_CONFLICT"
      )
        return { status: "CONFLICT" };
      return { status: "UNAVAILABLE" };
    }
    if (!response.ok) return { status: "UNAVAILABLE" };
    const result: unknown = await response.json();
    if (
      !record(result) ||
      !exact(result, [
        "status",
        "responseId",
        "revisionId",
        "version",
        "recordedAt",
      ]) ||
      (result.status !== "APPLIED" && result.status !== "DEDUPLICATED") ||
      typeof result.responseId !== "string" ||
      !uuid.test(result.responseId) ||
      result.revisionId !== input.commandId ||
      result.version !== input.expectedVersion + 1 ||
      !instant(result.recordedAt)
    ) {
      return { status: "UNAVAILABLE" };
    }
    return { status: "OK", version: result.version };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export type ModerationReportSubmit =
  | { readonly status: "OK" | "ALREADY_REPORTED" }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

export async function submitModerationReport(input: {
  readonly fetch: typeof fetch;
  readonly commandId: string;
  readonly targetType: ModerationReportTargetType;
  readonly targetId: string;
  readonly reason: ModerationReportReason;
  readonly details: string;
}): Promise<ModerationReportSubmit> {
  if (
    !uuid.test(input.commandId) ||
    !uuid.test(input.targetId) ||
    !moderationReportReasons.some(([reason]) => reason === input.reason) ||
    input.details.length > 1_000 ||
    input.details !== input.details.trim() ||
    control.test(input.details)
  ) {
    return { status: "UNAVAILABLE" };
  }
  const csrfResult = await csrf(input.fetch);
  if (csrfResult.status !== "OK") return { status: csrfResult.status };
  try {
    const response = await input.fetch.call(
      globalThis,
      "/v1/me/moderation/reports",
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrfResult.token,
        },
        body: JSON.stringify({
          commandId: input.commandId,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          details: input.details || null,
        }),
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) {
      const conflict: unknown = await response.json();
      return record(conflict) &&
        exact(conflict, ["code"]) &&
        conflict.code === "ALREADY_REPORTED"
        ? { status: "ALREADY_REPORTED" }
        : { status: "UNAVAILABLE" };
    }
    if (!response.ok) return { status: "UNAVAILABLE" };
    const result: unknown = await response.json();
    if (
      !record(result) ||
      !exact(result, ["status", "reportId", "state", "recordedAt"]) ||
      (result.status !== "APPLIED" && result.status !== "DEDUPLICATED") ||
      result.reportId !== input.commandId ||
      result.state !== "OPEN" ||
      !instant(result.recordedAt)
    ) {
      return { status: "UNAVAILABLE" };
    }
    return { status: "OK" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

function parseOwnerResponse(
  value: unknown,
  reviewId: string,
): OwnerReviewResponse | null {
  if (
    !record(value) ||
    !exact(value, [
      "responseId",
      "reviewId",
      "revisionId",
      "version",
      "body",
      "respondedAt",
      "revisedAt",
      "editDeadline",
    ]) ||
    typeof value.responseId !== "string" ||
    !uuid.test(value.responseId) ||
    value.reviewId !== reviewId ||
    typeof value.revisionId !== "string" ||
    !uuid.test(value.revisionId) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    typeof value.body !== "string" ||
    value.body.length > 2_000 ||
    !isPublicDisplayTextSafe(value.body) ||
    !instant(value.respondedAt) ||
    !instant(value.revisedAt) ||
    !instant(value.editDeadline) ||
    Date.parse(value.revisedAt) < Date.parse(value.respondedAt) ||
    Date.parse(value.editDeadline) <= Date.parse(value.respondedAt)
  ) {
    return null;
  }
  return value as unknown as OwnerReviewResponse;
}

async function csrf(
  fetcher: typeof fetch,
): Promise<
  | { readonly status: "OK"; readonly token: string }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" }
> {
  try {
    const response = await fetcher.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    const token =
      record(body) &&
      exact(body, ["csrfToken"]) &&
      typeof body.csrfToken === "string" &&
      body.csrfToken.length >= 1 &&
      body.csrfToken.length <= 1_000 &&
      !control.test(body.csrfToken)
        ? body.csrfToken
        : null;
    return token === null ? { status: "UNAVAILABLE" } : { status: "OK", token };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
