const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const control = /[\p{Cc}]/u;

type Dict = Record<string, unknown>;
export type JobMainReviewDirection =
  "CUSTOMER_TO_PROVIDER" | "PROVIDER_TO_CUSTOMER";
export type JobMainReviewState =
  "OPEN" | "SUBMITTED_SEALED" | "UNLOCKED" | "EXPIRED_UNSUBMITTED";
export type JobMainReviewRating = 1 | 2 | 3 | 4 | 5 | null;
export type JobMainReviewRatings = Readonly<
  Record<string, JobMainReviewRating>
>;

export const customerToProviderReviewDimensions = Object.freeze([
  ["work_quality", "Kvalita práce"],
  ["price_adherence", "Dodržanie dohodnutej ceny"],
  ["schedule_adherence", "Dodržanie termínu"],
  ["communication", "Komunikácia"],
  ["cleanliness", "Čistota a poriadok"],
  ["problem_solving", "Riešenie problémov"],
  ["would_hire_again", "Znovu by som si vybral/a tohto poskytovateľa"],
] as const);

export const providerToCustomerReviewDimensions = Object.freeze([
  ["agreement_payment_experience", "Skúsenosť s dodržaním dohody a platbou"],
  ["site_readiness", "Pripravenosť miesta realizácie"],
  ["brief_clarity", "Jasnosť zadania"],
  ["communication", "Komunikácia"],
  ["unplanned_changes", "Neplánované zmeny"],
  ["fairness", "Férovosť a korektnosť"],
] as const);

export interface OwnJobMainReview {
  readonly revisionId: string;
  readonly version: number;
  readonly submittedAt: string;
  readonly revisedAt: string;
  readonly ratings: JobMainReviewRatings;
  readonly comment: string | null;
}

export interface CounterpartyJobMainReview {
  readonly direction: JobMainReviewDirection;
  readonly revisionId: string;
  readonly submittedAt: string;
  readonly revisedAt: string;
  readonly unlockedAt: string;
  readonly ratings: JobMainReviewRatings;
  readonly comment: string | null;
}

export interface JobMainReviewPage {
  readonly jobId: string;
  readonly direction: JobMainReviewDirection;
  readonly targetProfileId: string;
  readonly targetKind: "CRAFTSMAN_PROFILE" | "CUSTOMER_PROFILE";
  readonly acceptedProfessionCode: string;
  readonly completedAt: string;
  readonly submissionDeadline: string;
  readonly state: JobMainReviewState;
  readonly ownReview: OwnJobMainReview | null;
  readonly counterpartyReview: CounterpartyJobMainReview | null;
}

export type JobMainReviewLoad =
  | { readonly status: "OK"; readonly page: JobMainReviewPage }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

export type JobMainReviewSubmitResult =
  | {
      readonly status: "OK";
      readonly outcome: "APPLIED" | "DEDUPLICATED";
      readonly version: number;
    }
  | {
      readonly status:
        | "AUTH_REQUIRED"
        | "NOT_FOUND"
        | "WINDOW_CLOSED"
        | "EDIT_LOCKED"
        | "CONFLICT"
        | "UNAVAILABLE";
    };

const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Dict, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const boundedComment = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 2_000 &&
  value === value.trim() &&
  !control.test(value);
const direction = (value: unknown): value is JobMainReviewDirection =>
  value === "CUSTOMER_TO_PROVIDER" || value === "PROVIDER_TO_CUSTOMER";
const dimensionsFor = (value: JobMainReviewDirection) =>
  value === "CUSTOMER_TO_PROVIDER"
    ? customerToProviderReviewDimensions
    : providerToCustomerReviewDimensions;

function parseRatings(
  value: unknown,
  reviewDirection: JobMainReviewDirection,
): JobMainReviewRatings | null {
  if (!record(value)) return null;
  const expected = dimensionsFor(reviewDirection).map(([key]) => key);
  const answered = Object.values(value).filter((rating) => rating !== null);
  if (
    !exact(value, expected) ||
    answered.length === 0 ||
    Object.values(value).some(
      (rating) =>
        rating !== null &&
        (!Number.isSafeInteger(rating) ||
          Number(rating) < 1 ||
          Number(rating) > 5),
    )
  )
    return null;
  return value as JobMainReviewRatings;
}

function parseOwnReview(
  value: unknown,
  reviewDirection: JobMainReviewDirection,
  completedAt: string,
): OwnJobMainReview | null | false {
  if (value === null) return null;
  if (
    !record(value) ||
    !exact(value, [
      "revisionId",
      "version",
      "submittedAt",
      "revisedAt",
      "ratings",
      "comment",
    ]) ||
    typeof value.revisionId !== "string" ||
    !uuid.test(value.revisionId) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !instant(value.submittedAt) ||
    !instant(value.revisedAt) ||
    Date.parse(value.submittedAt) < Date.parse(completedAt) ||
    Date.parse(value.revisedAt) < Date.parse(value.submittedAt) ||
    parseRatings(value.ratings, reviewDirection) === null ||
    (value.comment !== null && !boundedComment(value.comment))
  )
    return false;
  return value as unknown as OwnJobMainReview;
}

function parseCounterpartyReview(
  value: unknown,
  ownDirection: JobMainReviewDirection,
  completedAt: string,
): CounterpartyJobMainReview | null | false {
  if (value === null) return null;
  if (
    !record(value) ||
    !exact(value, [
      "direction",
      "revisionId",
      "submittedAt",
      "revisedAt",
      "unlockedAt",
      "ratings",
      "comment",
    ]) ||
    !direction(value.direction) ||
    value.direction === ownDirection ||
    typeof value.revisionId !== "string" ||
    !uuid.test(value.revisionId) ||
    !instant(value.submittedAt) ||
    !instant(value.revisedAt) ||
    !instant(value.unlockedAt) ||
    Date.parse(value.submittedAt) < Date.parse(completedAt) ||
    Date.parse(value.revisedAt) < Date.parse(value.submittedAt) ||
    Date.parse(value.unlockedAt) < Date.parse(value.revisedAt) ||
    parseRatings(value.ratings, value.direction) === null ||
    (value.comment !== null && !boundedComment(value.comment))
  )
    return false;
  return value as unknown as CounterpartyJobMainReview;
}

export function parseJobMainReviewPage(
  value: unknown,
  jobId: string,
): JobMainReviewPage | null {
  if (
    !uuid.test(jobId) ||
    !record(value) ||
    !exact(value, [
      "jobId",
      "direction",
      "targetProfileId",
      "targetKind",
      "acceptedProfessionCode",
      "completedAt",
      "submissionDeadline",
      "state",
      "ownReview",
      "counterpartyReview",
    ]) ||
    value.jobId !== jobId ||
    !direction(value.direction) ||
    typeof value.targetProfileId !== "string" ||
    !uuid.test(value.targetProfileId) ||
    (value.direction === "CUSTOMER_TO_PROVIDER" &&
      value.targetKind !== "CRAFTSMAN_PROFILE") ||
    (value.direction === "PROVIDER_TO_CUSTOMER" &&
      value.targetKind !== "CUSTOMER_PROFILE") ||
    typeof value.acceptedProfessionCode !== "string" ||
    !professionCode.test(value.acceptedProfessionCode) ||
    !instant(value.completedAt) ||
    !instant(value.submissionDeadline) ||
    Date.parse(value.submissionDeadline) <= Date.parse(value.completedAt) ||
    !["OPEN", "SUBMITTED_SEALED", "UNLOCKED", "EXPIRED_UNSUBMITTED"].includes(
      String(value.state),
    )
  )
    return null;
  const ownReview = parseOwnReview(
    value.ownReview,
    value.direction,
    value.completedAt,
  );
  const counterpartyReview = parseCounterpartyReview(
    value.counterpartyReview,
    value.direction,
    value.completedAt,
  );
  if (ownReview === false || counterpartyReview === false) return null;
  if (
    (value.state === "OPEN" &&
      (ownReview !== null || counterpartyReview !== null)) ||
    (value.state === "SUBMITTED_SEALED" &&
      (ownReview === null || counterpartyReview !== null)) ||
    (value.state === "UNLOCKED" && ownReview === null) ||
    (value.state === "EXPIRED_UNSUBMITTED" && ownReview !== null)
  )
    return null;
  return {
    ...(value as unknown as JobMainReviewPage),
    ownReview,
    counterpartyReview,
  };
}

export function reviewCanBeSubmittedOrEdited(
  page: JobMainReviewPage,
  now = Date.now(),
): boolean {
  if (now >= Date.parse(page.submissionDeadline)) return false;
  if (page.state === "OPEN") return page.ownReview === null;
  return (
    page.state === "SUBMITTED_SEALED" &&
    page.ownReview !== null &&
    now < Date.parse(page.ownReview.submittedAt) + 60 * 60 * 1_000
  );
}

export function validJobMainReviewDraft(
  directionValue: JobMainReviewDirection,
  ratings: JobMainReviewRatings,
  comment: string,
): boolean {
  return (
    parseRatings(ratings, directionValue) !== null &&
    (comment.trim().length === 0 || boundedComment(comment))
  );
}

export function createJobMainReviewCommandId(): string {
  return crypto.randomUUID();
}

export async function loadJobMainReview(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
}): Promise<JobMainReviewLoad> {
  if (!uuid.test(input.jobId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/reviews/main`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseJobMainReviewPage(await response.json(), input.jobId);
    return page ? { status: "OK", page } : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function submitJobMainReview(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly direction: JobMainReviewDirection;
  readonly ratings: JobMainReviewRatings;
  readonly comment: string;
}): Promise<JobMainReviewSubmitResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.commandId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !validJobMainReviewDraft(input.direction, input.ratings, input.comment)
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
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1_000 ||
      control.test(csrf.csrfToken)
    )
      return { status: "UNAVAILABLE" };
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/reviews/main`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.csrfToken,
        },
        body: JSON.stringify({
          commandId: input.commandId,
          expectedVersion: input.expectedVersion,
          ratings: input.ratings,
          comment: input.comment.trim() || null,
        }),
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) {
      const conflict: unknown = await response.json();
      if (!record(conflict) || !exact(conflict, ["code"]))
        return { status: "UNAVAILABLE" };
      if (conflict.code === "WINDOW_CLOSED") return { status: "WINDOW_CLOSED" };
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
        "direction",
        "revisionId",
        "version",
        "recordedAt",
      ]) ||
      (result.status !== "APPLIED" && result.status !== "DEDUPLICATED") ||
      result.direction !== input.direction ||
      typeof result.revisionId !== "string" ||
      !uuid.test(result.revisionId) ||
      result.revisionId.toLowerCase() !== input.commandId.toLowerCase() ||
      typeof result.version !== "number" ||
      !Number.isSafeInteger(result.version) ||
      result.version !== input.expectedVersion + 1 ||
      !instant(result.recordedAt)
    )
      return { status: "UNAVAILABLE" };
    return {
      status: "OK",
      outcome: result.status,
      version: result.version,
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
