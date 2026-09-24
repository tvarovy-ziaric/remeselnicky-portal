const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const control = /[\p{Cc}]/u;

type Dict = Record<string, unknown>;
export type JobContextReviewTargetKind = "PARTICIPANT" | "WORK_GROUP";
export type JobContextReviewRating = 1 | 2 | 3 | 4 | 5 | null;
export type JobContextReviewRatings = Readonly<
  Record<string, JobContextReviewRating>
>;
export type VerifiedJobParticipantRole =
  "MEMBER" | "LEAD" | "COORDINATOR" | "SITE_MANAGER";

export const participantReviewDimensions = Object.freeze([
  ["work_quality", "Kvalita práce"],
  ["price_adherence", "Dodržanie dohodnutej ceny"],
  ["schedule_adherence", "Dodržanie termínu"],
  ["communication", "Komunikácia"],
  ["cleanliness", "Čistota a poriadok"],
  ["problem_solving", "Riešenie problémov"],
  ["would_hire_again", "Znovu by som si vybral/a tohto remeselníka"],
] as const);

export const workGroupReviewDimensions = Object.freeze([
  ["result_quality", "Kvalita výsledku"],
  ["coordination", "Koordinácia"],
  ["timing", "Dodržanie času"],
  ["communication", "Komunikácia"],
  ["cleanliness", "Čistota a poriadok"],
  ["problem_solving", "Riešenie problémov"],
] as const);

export interface JobContextReviewContent {
  readonly revisionId: string;
  readonly version: number;
  readonly submittedAt: string;
  readonly revisedAt: string;
  readonly editDeadline: string;
  readonly ratings: JobContextReviewRatings;
  readonly comment: string | null;
}

export interface JobParticipantReviewTarget {
  readonly targetKind: "PARTICIPANT";
  readonly participantId: string;
  readonly participantProfileId: string;
  readonly displayName: string;
  readonly participationStartedAt: string;
  readonly participationEndedAt: string;
  readonly verifiedProfessionCodes: readonly string[];
  readonly verifiedRoles: readonly VerifiedJobParticipantRole[];
  readonly review: JobContextReviewContent | null;
}

export interface JobWorkGroupReviewMember {
  readonly assignmentId: string;
  readonly participantId: string;
  readonly participantProfileId: string;
  readonly displayName: string;
  readonly overlapStartedAt: string;
  readonly overlapEndedAt: string;
}

export interface JobWorkGroupReviewTarget {
  readonly targetKind: "WORK_GROUP";
  readonly workGroupId: string;
  readonly name: string;
  readonly members: readonly JobWorkGroupReviewMember[];
  readonly review: JobContextReviewContent | null;
}

export interface JobContextReviewPage {
  readonly jobId: string;
  readonly completedAt: string;
  readonly submissionDeadline: string;
  readonly participants: readonly JobParticipantReviewTarget[];
  readonly workGroups: readonly JobWorkGroupReviewTarget[];
}

export type JobContextReviewLoad =
  | { readonly status: "OK"; readonly page: JobContextReviewPage }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

export type JobContextReviewSubmitResult =
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
const boundedText = (value: unknown, maximum = 200): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  value === value.trim() &&
  !control.test(value);
const boundedComment = (value: unknown): value is string =>
  boundedText(value, 2_000);
const unique = (values: readonly string[]) =>
  new Set(values.map((value) => value.toLowerCase())).size === values.length;

export const dimensionsForContextTarget = (kind: JobContextReviewTargetKind) =>
  kind === "PARTICIPANT"
    ? participantReviewDimensions
    : workGroupReviewDimensions;

function parseRatings(
  value: unknown,
  targetKind: JobContextReviewTargetKind,
): JobContextReviewRatings | null {
  if (!record(value)) return null;
  const keys = dimensionsForContextTarget(targetKind).map(([key]) => key);
  if (
    !exact(value, keys) ||
    !Object.values(value).some((rating) => rating !== null) ||
    Object.values(value).some(
      (rating) =>
        rating !== null &&
        (!Number.isSafeInteger(rating) ||
          Number(rating) < 1 ||
          Number(rating) > 5),
    )
  )
    return null;
  return value as JobContextReviewRatings;
}

function parseReview(
  value: unknown,
  targetKind: JobContextReviewTargetKind,
  completedAt: string,
  submissionDeadline: string,
): JobContextReviewContent | null | false {
  if (value === null) return null;
  if (
    !record(value) ||
    !exact(value, [
      "revisionId",
      "version",
      "submittedAt",
      "revisedAt",
      "editDeadline",
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
    !instant(value.editDeadline) ||
    Date.parse(value.submittedAt) < Date.parse(completedAt) ||
    Date.parse(value.revisedAt) < Date.parse(value.submittedAt) ||
    Date.parse(value.revisedAt) > Date.parse(value.editDeadline) ||
    Date.parse(value.editDeadline) <= Date.parse(value.submittedAt) ||
    Date.parse(value.editDeadline) > Date.parse(submissionDeadline) ||
    parseRatings(value.ratings, targetKind) === null ||
    (value.comment !== null && !boundedComment(value.comment))
  )
    return false;
  return value as unknown as JobContextReviewContent;
}

function parseParticipant(
  value: unknown,
  completedAt: string,
  submissionDeadline: string,
): JobParticipantReviewTarget | null {
  if (
    !record(value) ||
    !exact(value, [
      "targetKind",
      "participantId",
      "participantProfileId",
      "displayName",
      "participationStartedAt",
      "participationEndedAt",
      "verifiedProfessionCodes",
      "verifiedRoles",
      "review",
    ]) ||
    value.targetKind !== "PARTICIPANT" ||
    typeof value.participantId !== "string" ||
    !uuid.test(value.participantId) ||
    typeof value.participantProfileId !== "string" ||
    !uuid.test(value.participantProfileId) ||
    !boundedText(value.displayName) ||
    !instant(value.participationStartedAt) ||
    !instant(value.participationEndedAt) ||
    Date.parse(value.participationEndedAt) <=
      Date.parse(value.participationStartedAt) ||
    Date.parse(value.participationEndedAt) > Date.parse(completedAt) ||
    !Array.isArray(value.verifiedProfessionCodes) ||
    value.verifiedProfessionCodes.length > 32 ||
    !value.verifiedProfessionCodes.every(
      (item: unknown) => typeof item === "string" && professionCode.test(item),
    ) ||
    !unique(value.verifiedProfessionCodes as string[]) ||
    !Array.isArray(value.verifiedRoles) ||
    value.verifiedRoles.length === 0 ||
    value.verifiedRoles.length > 4 ||
    !value.verifiedRoles.includes("MEMBER") ||
    !value.verifiedRoles.every((role: unknown) =>
      ["MEMBER", "LEAD", "COORDINATOR", "SITE_MANAGER"].includes(String(role)),
    ) ||
    !unique(value.verifiedRoles as string[])
  )
    return null;
  const review = parseReview(
    value.review,
    "PARTICIPANT",
    completedAt,
    submissionDeadline,
  );
  return review === false
    ? null
    : ({ ...value, review } as unknown as JobParticipantReviewTarget);
}

function parseWorkGroupMember(value: unknown): JobWorkGroupReviewMember | null {
  if (
    !record(value) ||
    !exact(value, [
      "assignmentId",
      "participantId",
      "participantProfileId",
      "displayName",
      "overlapStartedAt",
      "overlapEndedAt",
    ]) ||
    typeof value.assignmentId !== "string" ||
    !uuid.test(value.assignmentId) ||
    typeof value.participantId !== "string" ||
    !uuid.test(value.participantId) ||
    typeof value.participantProfileId !== "string" ||
    !uuid.test(value.participantProfileId) ||
    !boundedText(value.displayName) ||
    !instant(value.overlapStartedAt) ||
    !instant(value.overlapEndedAt) ||
    Date.parse(value.overlapEndedAt) <= Date.parse(value.overlapStartedAt)
  )
    return null;
  return value as unknown as JobWorkGroupReviewMember;
}

function parseWorkGroup(
  value: unknown,
  completedAt: string,
  submissionDeadline: string,
): JobWorkGroupReviewTarget | null {
  if (
    !record(value) ||
    !exact(value, ["targetKind", "workGroupId", "name", "members", "review"]) ||
    value.targetKind !== "WORK_GROUP" ||
    typeof value.workGroupId !== "string" ||
    !uuid.test(value.workGroupId) ||
    !boundedText(value.name, 120) ||
    !Array.isArray(value.members) ||
    value.members.length === 0 ||
    value.members.length > 200
  )
    return null;
  const members = value.members.map(parseWorkGroupMember);
  if (
    members.some((member) => member === null) ||
    !unique(
      (members as JobWorkGroupReviewMember[]).map(
        (member) => member.assignmentId,
      ),
    ) ||
    (members as JobWorkGroupReviewMember[]).some(
      (member) => Date.parse(member.overlapEndedAt) > Date.parse(completedAt),
    )
  )
    return null;
  const review = parseReview(
    value.review,
    "WORK_GROUP",
    completedAt,
    submissionDeadline,
  );
  return review === false
    ? null
    : ({ ...value, members, review } as unknown as JobWorkGroupReviewTarget);
}

export function parseJobContextReviewPage(
  value: unknown,
  jobId: string,
): JobContextReviewPage | null {
  if (
    !uuid.test(jobId) ||
    !record(value) ||
    !exact(value, [
      "jobId",
      "completedAt",
      "submissionDeadline",
      "participants",
      "workGroups",
    ]) ||
    value.jobId !== jobId ||
    !instant(value.completedAt) ||
    !instant(value.submissionDeadline) ||
    Date.parse(value.submissionDeadline) <= Date.parse(value.completedAt) ||
    !Array.isArray(value.participants) ||
    value.participants.length > 200 ||
    !Array.isArray(value.workGroups) ||
    value.workGroups.length > 200
  )
    return null;
  const participants = value.participants.map((participant) =>
    parseParticipant(
      participant,
      value.completedAt as string,
      value.submissionDeadline as string,
    ),
  );
  const workGroups = value.workGroups.map((group) =>
    parseWorkGroup(
      group,
      value.completedAt as string,
      value.submissionDeadline as string,
    ),
  );
  if (
    participants.some((target) => target === null) ||
    workGroups.some((target) => target === null) ||
    !unique(
      (participants as JobParticipantReviewTarget[]).map(
        (target) => target.participantId,
      ),
    ) ||
    !unique(
      (workGroups as JobWorkGroupReviewTarget[]).map(
        (target) => target.workGroupId,
      ),
    )
  )
    return null;
  return {
    jobId,
    completedAt: value.completedAt,
    submissionDeadline: value.submissionDeadline,
    participants: participants as JobParticipantReviewTarget[],
    workGroups: workGroups as JobWorkGroupReviewTarget[],
  };
}

export function contextReviewCanBeSubmittedOrEdited(
  target: JobParticipantReviewTarget | JobWorkGroupReviewTarget,
  submissionDeadline: string,
  now = Date.now(),
): boolean {
  if (now >= Date.parse(submissionDeadline)) return false;
  return target.review === null || now < Date.parse(target.review.editDeadline);
}

export function validJobContextReviewDraft(
  targetKind: JobContextReviewTargetKind,
  ratings: JobContextReviewRatings,
  comment: string,
): boolean {
  return (
    parseRatings(ratings, targetKind) !== null &&
    (comment.trim().length === 0 || boundedComment(comment))
  );
}

export function createJobContextReviewCommandId(): string {
  return crypto.randomUUID();
}

export async function loadJobContextReviews(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
}): Promise<JobContextReviewLoad> {
  if (!uuid.test(input.jobId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/reviews/secondary`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseJobContextReviewPage(await response.json(), input.jobId);
    return page ? { status: "OK", page } : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function submitJobContextReview(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly targetKind: JobContextReviewTargetKind;
  readonly targetId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly ratings: JobContextReviewRatings;
  readonly comment: string;
}): Promise<JobContextReviewSubmitResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.targetId) ||
    !uuid.test(input.commandId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !validJobContextReviewDraft(input.targetKind, input.ratings, input.comment)
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
    const segment =
      input.targetKind === "PARTICIPANT" ? "participants" : "work-groups";
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/reviews/${segment}/${input.targetId}`,
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
        "targetKind",
        "targetId",
        "revisionId",
        "version",
        "recordedAt",
      ]) ||
      (result.status !== "APPLIED" && result.status !== "DEDUPLICATED") ||
      result.targetKind !== input.targetKind ||
      typeof result.targetId !== "string" ||
      result.targetId.toLowerCase() !== input.targetId.toLowerCase() ||
      typeof result.revisionId !== "string" ||
      !uuid.test(result.revisionId) ||
      result.revisionId.toLowerCase() !== input.commandId.toLowerCase() ||
      typeof result.version !== "number" ||
      !Number.isSafeInteger(result.version) ||
      result.version !== input.expectedVersion + 1 ||
      !instant(result.recordedAt)
    )
      return { status: "UNAVAILABLE" };
    return { status: "OK", outcome: result.status, version: result.version };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
