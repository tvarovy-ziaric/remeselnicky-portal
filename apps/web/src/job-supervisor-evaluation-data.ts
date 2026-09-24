export type SupervisorEvaluationRating = 1 | 2 | 3 | 4 | 5 | null;

export const supervisorEvaluationDimensions = Object.freeze([
  ["competence_quality", "Odborná kvalita a kompetentnosť"],
  ["reliability", "Spoľahlivosť"],
  ["independence", "Samostatnosť"],
  ["productivity", "Produktivita"],
  ["collaboration", "Spolupráca"],
  ["problem_solving", "Riešenie problémov"],
  ["would_take_into_crew_again", "Zobral/a by som ho/ju znovu do tímu"],
] as const);

export type SupervisorEvaluationDimension =
  (typeof supervisorEvaluationDimensions)[number][0];
export type SupervisorEvaluationRatings = Readonly<
  Record<SupervisorEvaluationDimension, SupervisorEvaluationRating>
>;
export type SupervisorRelationshipKind =
  "PRIMARY_CONTRACTOR" | "LEAD" | "COORDINATOR" | "SITE_MANAGER";
export type SupervisorVerifiedRole =
  "MEMBER" | "LEAD" | "COORDINATOR" | "SITE_MANAGER";

export interface OwnSupervisorEvaluation {
  readonly evaluationId: string;
  readonly revisionId: string;
  readonly version: number;
  readonly submittedAt: string;
  readonly revisedAt: string;
  readonly editDeadline: string;
  readonly ratings: SupervisorEvaluationRatings;
  readonly comment: string | null;
}

export interface SupervisorEvaluationTarget {
  readonly participantId: string;
  readonly participantProfileId: string;
  readonly displayName: string;
  readonly relationshipKind: SupervisorRelationshipKind;
  readonly overlapStartedAt: string;
  readonly overlapEndedAt: string;
  readonly verifiedProfessionCodes: readonly string[];
  readonly verifiedRoles: readonly SupervisorVerifiedRole[];
  readonly evaluation: OwnSupervisorEvaluation | null;
}

export interface SupervisorEvaluationPage {
  readonly jobId: string;
  readonly completedAt: string;
  readonly submissionDeadline: string;
  readonly targets: readonly SupervisorEvaluationTarget[];
}

export interface ReceivedSupervisorEvaluation {
  readonly sourceType: "SUPERVISOR_EVALUATION";
  readonly evaluationId: string;
  readonly targetParticipantId: string;
  readonly targetProfileId: string;
  readonly evaluatorDisplayName: string;
  readonly relationshipKind: SupervisorRelationshipKind;
  readonly overlapStartedAt: string;
  readonly overlapEndedAt: string;
  readonly verifiedProfessionCodes: readonly string[];
  readonly verifiedTargetRoles: readonly SupervisorVerifiedRole[];
  readonly submittedAt: string;
  readonly revisedAt: string;
  readonly ratings: SupervisorEvaluationRatings;
  readonly comment: string | null;
}

export interface ReceivedSupervisorEvaluationPage {
  readonly jobId: string;
  readonly evaluations: readonly ReceivedSupervisorEvaluation[];
}

export type SupervisorEvaluationLoad =
  | { readonly status: "OK"; readonly page: SupervisorEvaluationPage }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };
export type ReceivedSupervisorEvaluationLoad =
  | { readonly status: "OK"; readonly page: ReceivedSupervisorEvaluationPage }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };
export type SupervisorEvaluationDetailLoad =
  | { readonly status: "OK"; readonly evaluation: ReceivedSupervisorEvaluation }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };
export type SupervisorEvaluationSubmitResult =
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

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const control = /[\p{Cc}]/u;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  value === value.trim() &&
  !control.test(value);
const relationship = (value: unknown): value is SupervisorRelationshipKind =>
  ["PRIMARY_CONTRACTOR", "LEAD", "COORDINATOR", "SITE_MANAGER"].includes(
    String(value),
  );
const verifiedRole = (value: unknown): value is SupervisorVerifiedRole =>
  ["MEMBER", "LEAD", "COORDINATOR", "SITE_MANAGER"].includes(String(value));

function parseRatings(value: unknown): SupervisorEvaluationRatings | null {
  if (!record(value)) return null;
  const keys = supervisorEvaluationDimensions.map(([key]) => key);
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
  return value as unknown as SupervisorEvaluationRatings;
}

function parseCodes(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !value.every(
      (item) => typeof item === "string" && professionCode.test(item),
    ) ||
    new Set(value).size !== value.length
  )
    return null;
  return value as string[];
}

function parseRoles(value: unknown): readonly SupervisorVerifiedRole[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    !value.every(verifiedRole) ||
    new Set(value).size !== value.length
  )
    return null;
  return value;
}

function parseOwnEvaluation(
  value: unknown,
  completedAt: string,
  submissionDeadline: string,
): OwnSupervisorEvaluation | null | false {
  if (value === null) return null;
  if (
    !record(value) ||
    !exact(value, [
      "evaluationId",
      "revisionId",
      "version",
      "submittedAt",
      "revisedAt",
      "editDeadline",
      "ratings",
      "comment",
    ]) ||
    typeof value.evaluationId !== "string" ||
    !uuid.test(value.evaluationId) ||
    typeof value.revisionId !== "string" ||
    !uuid.test(value.revisionId) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    !instant(value.submittedAt) ||
    !instant(value.revisedAt) ||
    !instant(value.editDeadline) ||
    Date.parse(value.submittedAt) < Date.parse(completedAt) ||
    Date.parse(value.revisedAt) < Date.parse(value.submittedAt) ||
    Date.parse(value.editDeadline) < Date.parse(value.submittedAt) ||
    Date.parse(value.editDeadline) > Date.parse(submissionDeadline) ||
    parseRatings(value.ratings) === null ||
    (value.comment !== null && !boundedText(value.comment, 2_000))
  )
    return false;
  return value as unknown as OwnSupervisorEvaluation;
}

function parseTarget(
  value: unknown,
  completedAt: string,
  submissionDeadline: string,
): SupervisorEvaluationTarget | null {
  if (
    !record(value) ||
    !exact(value, [
      "participantId",
      "participantProfileId",
      "displayName",
      "relationshipKind",
      "overlapStartedAt",
      "overlapEndedAt",
      "verifiedProfessionCodes",
      "verifiedRoles",
      "evaluation",
    ]) ||
    typeof value.participantId !== "string" ||
    !uuid.test(value.participantId) ||
    typeof value.participantProfileId !== "string" ||
    !uuid.test(value.participantProfileId) ||
    !boundedText(value.displayName, 255) ||
    !relationship(value.relationshipKind) ||
    !instant(value.overlapStartedAt) ||
    !instant(value.overlapEndedAt) ||
    Date.parse(value.overlapEndedAt) <= Date.parse(value.overlapStartedAt) ||
    Date.parse(value.overlapEndedAt) > Date.parse(completedAt)
  )
    return null;
  const codes = parseCodes(value.verifiedProfessionCodes);
  const roles = parseRoles(value.verifiedRoles);
  const evaluation = parseOwnEvaluation(
    value.evaluation,
    completedAt,
    submissionDeadline,
  );
  return codes === null || roles === null || evaluation === false
    ? null
    : ({
        ...value,
        verifiedProfessionCodes: codes,
        verifiedRoles: roles,
        evaluation,
      } as unknown as SupervisorEvaluationTarget);
}

export function parseSupervisorEvaluationPage(
  value: unknown,
  jobId: string,
): SupervisorEvaluationPage | null {
  if (
    !uuid.test(jobId) ||
    !record(value) ||
    !exact(value, ["jobId", "completedAt", "submissionDeadline", "targets"]) ||
    value.jobId !== jobId ||
    !instant(value.completedAt) ||
    !instant(value.submissionDeadline) ||
    Date.parse(value.submissionDeadline) <= Date.parse(value.completedAt) ||
    !Array.isArray(value.targets) ||
    value.targets.length > 200
  )
    return null;
  const targets = value.targets.map((target) =>
    parseTarget(
      target,
      value.completedAt as string,
      value.submissionDeadline as string,
    ),
  );
  if (
    targets.some((target) => target === null) ||
    new Set(
      (targets as SupervisorEvaluationTarget[]).map(
        (target) => target.participantId,
      ),
    ).size !== targets.length
  )
    return null;
  return {
    ...(value as unknown as SupervisorEvaluationPage),
    targets: targets as SupervisorEvaluationTarget[],
  };
}

function parseReceived(value: unknown): ReceivedSupervisorEvaluation | null {
  if (
    !record(value) ||
    !exact(value, [
      "sourceType",
      "evaluationId",
      "targetParticipantId",
      "targetProfileId",
      "evaluatorDisplayName",
      "relationshipKind",
      "overlapStartedAt",
      "overlapEndedAt",
      "verifiedProfessionCodes",
      "verifiedTargetRoles",
      "submittedAt",
      "revisedAt",
      "ratings",
      "comment",
    ]) ||
    value.sourceType !== "SUPERVISOR_EVALUATION" ||
    typeof value.evaluationId !== "string" ||
    !uuid.test(value.evaluationId) ||
    typeof value.targetParticipantId !== "string" ||
    !uuid.test(value.targetParticipantId) ||
    typeof value.targetProfileId !== "string" ||
    !uuid.test(value.targetProfileId) ||
    !boundedText(value.evaluatorDisplayName, 255) ||
    !relationship(value.relationshipKind) ||
    !instant(value.overlapStartedAt) ||
    !instant(value.overlapEndedAt) ||
    Date.parse(value.overlapEndedAt) <= Date.parse(value.overlapStartedAt) ||
    !instant(value.submittedAt) ||
    !instant(value.revisedAt) ||
    Date.parse(value.revisedAt) < Date.parse(value.submittedAt) ||
    parseRatings(value.ratings) === null ||
    (value.comment !== null && !boundedText(value.comment, 2_000))
  )
    return null;
  const codes = parseCodes(value.verifiedProfessionCodes);
  const roles = parseRoles(value.verifiedTargetRoles);
  return codes === null || roles === null
    ? null
    : ({
        ...value,
        verifiedProfessionCodes: codes,
        verifiedTargetRoles: roles,
      } as unknown as ReceivedSupervisorEvaluation);
}

export function parseReceivedSupervisorEvaluationPage(
  value: unknown,
  jobId: string,
): ReceivedSupervisorEvaluationPage | null {
  if (
    !uuid.test(jobId) ||
    !record(value) ||
    !exact(value, ["jobId", "evaluations"]) ||
    value.jobId !== jobId ||
    !Array.isArray(value.evaluations) ||
    value.evaluations.length > 200
  )
    return null;
  const evaluations = value.evaluations.map(parseReceived);
  if (
    evaluations.some((evaluation) => evaluation === null) ||
    new Set(
      (evaluations as ReceivedSupervisorEvaluation[]).map(
        (evaluation) => evaluation.evaluationId,
      ),
    ).size !== evaluations.length
  )
    return null;
  return {
    ...(value as unknown as ReceivedSupervisorEvaluationPage),
    evaluations: evaluations as ReceivedSupervisorEvaluation[],
  };
}

export function validSupervisorEvaluationDraft(
  ratings: SupervisorEvaluationRatings,
  comment: string,
): boolean {
  return (
    parseRatings(ratings) !== null &&
    (comment.trim().length === 0 || boundedText(comment, 2_000))
  );
}

export function createSupervisorEvaluationCommandId(): string {
  return crypto.randomUUID();
}

export async function loadSupervisorEvaluations(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
}): Promise<SupervisorEvaluationLoad> {
  if (!uuid.test(input.jobId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/supervisor-evaluations`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseSupervisorEvaluationPage(
      await response.json(),
      input.jobId,
    );
    return page === null ? { status: "UNAVAILABLE" } : { status: "OK", page };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function loadReceivedSupervisorEvaluations(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
}): Promise<ReceivedSupervisorEvaluationLoad> {
  if (!uuid.test(input.jobId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/supervisor-evaluations/received`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseReceivedSupervisorEvaluationPage(
      await response.json(),
      input.jobId,
    );
    return page === null ? { status: "UNAVAILABLE" } : { status: "OK", page };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function loadSupervisorEvaluationDetail(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly evaluationId: string;
}): Promise<SupervisorEvaluationDetailLoad> {
  if (!uuid.test(input.jobId) || !uuid.test(input.evaluationId))
    return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/supervisor-evaluations/${input.evaluationId}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const evaluation = parseReceived(await response.json());
    return evaluation === null || evaluation.evaluationId !== input.evaluationId
      ? { status: "UNAVAILABLE" }
      : { status: "OK", evaluation };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function submitSupervisorEvaluation(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly participantId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly ratings: SupervisorEvaluationRatings;
  readonly comment: string;
}): Promise<SupervisorEvaluationSubmitResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.participantId) ||
    !uuid.test(input.commandId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !validSupervisorEvaluationDraft(input.ratings, input.comment)
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
      `/v1/me/jobs/${input.jobId}/supervisor-evaluations/participants/${input.participantId}`,
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
        "evaluationId",
        "revisionId",
        "version",
        "recordedAt",
      ]) ||
      (result.status !== "APPLIED" && result.status !== "DEDUPLICATED") ||
      typeof result.evaluationId !== "string" ||
      !uuid.test(result.evaluationId) ||
      typeof result.revisionId !== "string" ||
      !uuid.test(result.revisionId) ||
      result.revisionId.toLowerCase() !== input.commandId.toLowerCase() ||
      !Number.isSafeInteger(result.version) ||
      Number(result.version) !== input.expectedVersion + 1 ||
      !instant(result.recordedAt)
    )
      return { status: "UNAVAILABLE" };
    return {
      status: "OK",
      outcome: result.status,
      version: Number(result.version),
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
