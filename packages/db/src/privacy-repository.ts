import {
  CONSENT_ACTION_VALUES,
  OPTIONAL_CONSENT_PURPOSE_VALUES,
  PRIVACY_POLICY_KIND_VALUES,
  PRIVACY_REQUEST_STATE_VALUES,
  PRIVACY_REQUEST_TYPE_VALUES,
  PRIVACY_REVIEW_STATE_VALUES,
  RETENTION_CATEGORY_VALUES,
  RETENTION_LAUNCH_STATE_VALUES,
  type ConsentEvent,
  type ConsentEventDraft,
  type CreatePrivacyRequestCaseResult,
  type PrivacyPolicyVersion,
  type PrivacyPolicyVersionDraft,
  type PrivacyRepository,
  type PrivacyRequestCaseDraft,
  type PrivacyRequestEvent,
  type PrivacyRequestEventDraft,
  type PrivacyRequestState,
  type RetentionCategory,
  type RetentionPolicyVersion,
  type RetentionPolicyVersionDraft,
} from "@portal/privacy";
import type { UserId } from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface PolicyRow {
  readonly contentSha256: string;
  readonly createdAt: Date;
  readonly effectiveAt: Date | null;
  readonly optionalConsentPurpose: PrivacyPolicyVersion["optionalConsentPurpose"];
  readonly policyKind: PrivacyPolicyVersion["policyKind"];
  readonly policyVersionId: string;
  readonly reviewState: PrivacyPolicyVersion["reviewState"];
  readonly supersedesPolicyVersionId: string | null;
  readonly versionLabel: string;
}

interface ConsentRow {
  readonly action: ConsentEvent["action"];
  readonly correlationId: string;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly policyVersionId: string;
  readonly purpose: ConsentEvent["purpose"];
  readonly revision: number;
  readonly subjectUserId: UserId;
}

interface RetentionRow {
  readonly category: RetentionPolicyVersion["category"];
  readonly createdAt: Date;
  readonly durationDays: number | null;
  readonly launchState: RetentionPolicyVersion["launchState"];
  readonly legalReviewState: RetentionPolicyVersion["legalReviewState"];
  readonly policyVersionId: string;
  readonly rationaleCode: string;
  readonly supersedesPolicyVersionId: string | null;
  readonly version: number;
}

interface PrivacyCaseRow {
  readonly caseId: string;
  readonly receivedAt: Date;
  readonly requestType: PrivacyRequestCaseDraft["requestType"];
  readonly subjectUserId: UserId;
}

interface PrivacyRequestEventRow {
  readonly actionCode: string | null;
  readonly actorUserId: UserId;
  readonly caseId: string;
  readonly correlationId: string;
  readonly deadlineAt: Date | null;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly revision: number;
  readonly state: PrivacyRequestState;
  readonly subjectUserId: UserId;
}

interface ConsentPolicyRow {
  readonly effectiveAt: Date | null;
  readonly optionalConsentPurpose: PrivacyPolicyVersion["optionalConsentPurpose"];
  readonly policyKind: PrivacyPolicyVersion["policyKind"];
  readonly reviewState: PrivacyPolicyVersion["reviewState"];
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const versionLabelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const actionCodePattern = /^[A-Z][A-Z0-9_]{2,63}$/u;

export function createPrivacyRepository(sql: Sql): PrivacyRepository {
  return Object.freeze({
    appendPolicyVersion(policy: PrivacyPolicyVersionDraft) {
      assertPolicyVersion(policy);
      return sql.begin(async (transaction) => {
        if (policy.supersedesPolicyVersionId !== null) {
          const [superseded] = await transaction<PolicyRow[]>`
            SELECT
              policy_version_id AS "policyVersionId",
              policy_kind AS "policyKind",
              optional_consent_purpose AS "optionalConsentPurpose",
              version_label AS "versionLabel",
              content_sha256 AS "contentSha256",
              review_state AS "reviewState",
              effective_at AS "effectiveAt",
              supersedes_policy_version_id AS "supersedesPolicyVersionId",
              created_at AS "createdAt"
            FROM privacy_policy_versions
            WHERE policy_version_id = ${policy.supersedesPolicyVersionId}
          `;
          if (
            superseded === undefined ||
            superseded.policyKind !== policy.policyKind ||
            superseded.optionalConsentPurpose !== policy.optionalConsentPurpose
          ) {
            throw new Error("Policy supersession must preserve policy kind.");
          }
        }
        const [inserted] = await transaction<PolicyRow[]>`
          INSERT INTO privacy_policy_versions (
            policy_version_id,
            policy_kind,
            optional_consent_purpose,
            version_label,
            content_sha256,
            review_state,
            effective_at,
            supersedes_policy_version_id
          ) VALUES (
            ${policy.policyVersionId},
            ${policy.policyKind},
            ${policy.optionalConsentPurpose},
            ${policy.versionLabel},
            ${policy.contentSha256},
            ${policy.reviewState},
            ${policy.effectiveAt},
            ${policy.supersedesPolicyVersionId}
          )
          ON CONFLICT (policy_version_id) DO NOTHING
          RETURNING
            policy_version_id AS "policyVersionId",
            policy_kind AS "policyKind",
            optional_consent_purpose AS "optionalConsentPurpose",
            version_label AS "versionLabel",
            content_sha256 AS "contentSha256",
            review_state AS "reviewState",
            effective_at AS "effectiveAt",
            supersedes_policy_version_id AS "supersedesPolicyVersionId",
            created_at AS "createdAt"
        `;
        if (inserted !== undefined) {
          return Object.freeze({
            policy: toPolicy(inserted),
            status: "APPENDED" as const,
          });
        }
        const [existing] = await transaction<PolicyRow[]>`
          SELECT
            policy_version_id AS "policyVersionId",
            policy_kind AS "policyKind",
            optional_consent_purpose AS "optionalConsentPurpose",
            version_label AS "versionLabel",
            content_sha256 AS "contentSha256",
            review_state AS "reviewState",
            effective_at AS "effectiveAt",
            supersedes_policy_version_id AS "supersedesPolicyVersionId",
            created_at AS "createdAt"
          FROM privacy_policy_versions
          WHERE policy_version_id = ${policy.policyVersionId}
        `;
        if (existing === undefined || !samePolicy(existing, policy)) {
          throw new Error("Privacy policy idempotency conflict.");
        }
        return Object.freeze({
          policy: toPolicy(existing),
          status: "DEDUPLICATED" as const,
        });
      });
    },

    appendConsentEvent(event: ConsentEventDraft) {
      assertConsentEvent(event);
      return sql.begin(async (transaction) => {
        await lockConsent(transaction, event);
        const [existing] = await transaction<ConsentRow[]>`
          SELECT
            event_id AS "eventId",
            correlation_id AS "correlationId",
            subject_user_id AS "subjectUserId",
            purpose,
            action,
            policy_version_id AS "policyVersionId",
            revision,
            occurred_at AS "occurredAt"
          FROM privacy_consent_events
          WHERE event_id = ${event.eventId}
        `;
        if (existing !== undefined) {
          if (!sameConsentEvent(existing, event)) {
            throw new Error("Consent event idempotency conflict.");
          }
          return Object.freeze({
            event: toConsentEvent(existing),
            status: "DEDUPLICATED" as const,
          });
        }

        const [policy] = await transaction<ConsentPolicyRow[]>`
          SELECT
            policy_kind AS "policyKind",
            optional_consent_purpose AS "optionalConsentPurpose",
            review_state AS "reviewState",
            effective_at AS "effectiveAt"
          FROM privacy_policy_versions
          WHERE policy_version_id = ${event.policyVersionId}
            AND policy_kind = 'OPTIONAL_CONSENT_TEXT'
            AND optional_consent_purpose = ${event.purpose}
            AND review_state = 'APPROVED'
            AND effective_at <= CURRENT_TIMESTAMP
        `;
        if (
          policy === undefined ||
          policy.policyKind !== "OPTIONAL_CONSENT_TEXT" ||
          policy.optionalConsentPurpose !== event.purpose ||
          policy.reviewState !== "APPROVED" ||
          policy.effectiveAt === null
        ) {
          return Object.freeze({ status: "POLICY_NOT_APPROVED" as const });
        }

        const [current] = await transaction<ConsentRow[]>`
          SELECT
            event_id AS "eventId",
            correlation_id AS "correlationId",
            subject_user_id AS "subjectUserId",
            purpose,
            action,
            policy_version_id AS "policyVersionId",
            revision,
            occurred_at AS "occurredAt"
          FROM privacy_consent_events
          WHERE subject_user_id = ${event.subjectUserId}
            AND purpose = ${event.purpose}
          ORDER BY revision DESC
          LIMIT 1
        `;
        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== event.expectedRevision) {
          return Object.freeze({
            currentRevision,
            status: "STALE" as const,
          });
        }
        if (
          current?.action === event.action ||
          (current === undefined && event.action === "WITHDRAWN")
        ) {
          return Object.freeze({
            currentRevision,
            status: "UNCHANGED" as const,
          });
        }

        const [inserted] = await transaction<ConsentRow[]>`
          INSERT INTO privacy_consent_events (
            event_id,
            correlation_id,
            subject_user_id,
            purpose,
            action,
            policy_version_id,
            revision
          ) VALUES (
            ${event.eventId},
            ${event.correlationId},
            ${event.subjectUserId},
            ${event.purpose},
            ${event.action},
            ${event.policyVersionId},
            ${currentRevision + 1}
          )
          RETURNING
            event_id AS "eventId",
            correlation_id AS "correlationId",
            subject_user_id AS "subjectUserId",
            purpose,
            action,
            policy_version_id AS "policyVersionId",
            revision,
            occurred_at AS "occurredAt"
        `;
        if (inserted === undefined) {
          throw new Error("Consent event was not persisted.");
        }
        return Object.freeze({
          event: toConsentEvent(inserted),
          status: "APPENDED" as const,
        });
      });
    },

    appendRetentionPolicyVersion(policy: RetentionPolicyVersionDraft) {
      assertRetentionPolicy(policy);
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('privacy-retention:' || ${policy.category}, 0)
          )
        `;
        const [existing] = await transaction<RetentionRow[]>`
          SELECT
            policy_version_id AS "policyVersionId",
            category,
            version,
            duration_days AS "durationDays",
            legal_review_state AS "legalReviewState",
            launch_state AS "launchState",
            rationale_code AS "rationaleCode",
            supersedes_policy_version_id AS "supersedesPolicyVersionId",
            created_at AS "createdAt"
          FROM privacy_retention_policy_versions
          WHERE policy_version_id = ${policy.policyVersionId}
        `;
        if (existing !== undefined) {
          if (!sameRetention(existing, policy)) {
            throw new Error("Retention policy idempotency conflict.");
          }
          return Object.freeze({
            policy: toRetentionPolicy(existing),
            status: "DEDUPLICATED" as const,
          });
        }

        const [current] = await transaction<RetentionRow[]>`
            SELECT
              policy_version_id AS "policyVersionId",
              category,
              version,
              duration_days AS "durationDays",
              legal_review_state AS "legalReviewState",
              launch_state AS "launchState",
              rationale_code AS "rationaleCode",
              supersedes_policy_version_id AS "supersedesPolicyVersionId",
              created_at AS "createdAt"
            FROM privacy_retention_policy_versions
            WHERE category = ${policy.category}
            ORDER BY version DESC
            LIMIT 1
            FOR UPDATE
          `;
        if (
          (current === undefined &&
            (policy.version !== 1 ||
              policy.supersedesPolicyVersionId !== null)) ||
          (current !== undefined &&
            (policy.version !== current.version + 1 ||
              policy.supersedesPolicyVersionId !== current.policyVersionId))
        ) {
          throw new Error(
            "Retention supersession must extend the current category head contiguously.",
          );
        }
        const [inserted] = await transaction<RetentionRow[]>`
          INSERT INTO privacy_retention_policy_versions (
            policy_version_id,
            category,
            version,
            duration_days,
            legal_review_state,
            launch_state,
            rationale_code,
            supersedes_policy_version_id
          ) VALUES (
            ${policy.policyVersionId},
            ${policy.category},
            ${policy.version},
            ${policy.durationDays},
            ${policy.legalReviewState},
            ${policy.launchState},
            ${policy.rationaleCode},
            ${policy.supersedesPolicyVersionId}
          )
          ON CONFLICT (policy_version_id) DO NOTHING
          RETURNING
            policy_version_id AS "policyVersionId",
            category,
            version,
            duration_days AS "durationDays",
            legal_review_state AS "legalReviewState",
            launch_state AS "launchState",
            rationale_code AS "rationaleCode",
            supersedes_policy_version_id AS "supersedesPolicyVersionId",
            created_at AS "createdAt"
        `;
        if (inserted !== undefined) {
          return Object.freeze({
            policy: toRetentionPolicy(inserted),
            status: "APPENDED" as const,
          });
        }
        const [conflicting] = await transaction<RetentionRow[]>`
          SELECT
            policy_version_id AS "policyVersionId",
            category,
            version,
            duration_days AS "durationDays",
            legal_review_state AS "legalReviewState",
            launch_state AS "launchState",
            rationale_code AS "rationaleCode",
            supersedes_policy_version_id AS "supersedesPolicyVersionId",
            created_at AS "createdAt"
          FROM privacy_retention_policy_versions
          WHERE policy_version_id = ${policy.policyVersionId}
        `;
        if (conflicting === undefined || !sameRetention(conflicting, policy)) {
          throw new Error("Retention policy idempotency conflict.");
        }
        return Object.freeze({
          policy: toRetentionPolicy(conflicting),
          status: "DEDUPLICATED" as const,
        });
      });
    },

    async findLatestRetentionPolicy(category: RetentionCategory) {
      if (!RETENTION_CATEGORY_VALUES.includes(category)) return null;
      const [row] = await sql<RetentionRow[]>`
        SELECT
          policy_version_id AS "policyVersionId",
          category,
          version,
          duration_days AS "durationDays",
          legal_review_state AS "legalReviewState",
          launch_state AS "launchState",
          rationale_code AS "rationaleCode",
          supersedes_policy_version_id AS "supersedesPolicyVersionId",
          created_at AS "createdAt"
        FROM privacy_retention_policy_versions
        WHERE category = ${category}
        ORDER BY version DESC
        LIMIT 1
      `;
      return row === undefined ? null : toRetentionPolicy(row);
    },

    createPrivacyRequestCase(request: PrivacyRequestCaseDraft) {
      assertPrivacyRequestCase(request);
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('privacy-request:' || ${request.caseId}, 0)
          )
        `;
        const [existingCase] = await transaction<PrivacyCaseRow[]>`
          SELECT
            case_id AS "caseId",
            subject_user_id AS "subjectUserId",
            request_type AS "requestType",
            received_at AS "receivedAt"
          FROM privacy_request_cases
          WHERE case_id = ${request.caseId}
          FOR UPDATE
        `;
        if (existingCase !== undefined) {
          const [existingEvent] = await transaction<PrivacyRequestEventRow[]>`
            SELECT
              event.event_id AS "eventId",
              event.correlation_id AS "correlationId",
              event.case_id AS "caseId",
              event.actor_user_id AS "actorUserId",
              event.revision,
              event.state,
              event.deadline_at AS "deadlineAt",
              event.action_code AS "actionCode",
              event.occurred_at AS "occurredAt",
              privacy_case.subject_user_id AS "subjectUserId"
            FROM privacy_request_events AS event
            INNER JOIN privacy_request_cases AS privacy_case
              ON privacy_case.case_id = event.case_id
            WHERE event.event_id = ${request.eventId}
          `;
          if (
            existingEvent === undefined ||
            existingCase.subjectUserId !== request.subjectUserId ||
            existingCase.requestType !== request.requestType ||
            existingEvent.caseId !== request.caseId ||
            existingEvent.correlationId !== request.correlationId ||
            existingEvent.state !== "RECEIVED"
          ) {
            throw new Error("Privacy request idempotency conflict.");
          }
          return toPrivacyCaseResult(
            existingCase,
            existingEvent,
            "DEDUPLICATED",
          );
        }

        const [createdCase] = await transaction<PrivacyCaseRow[]>`
          INSERT INTO privacy_request_cases (
            case_id,
            subject_user_id,
            request_type
          ) VALUES (
            ${request.caseId},
            ${request.subjectUserId},
            ${request.requestType}
          )
          RETURNING
            case_id AS "caseId",
            subject_user_id AS "subjectUserId",
            request_type AS "requestType",
            received_at AS "receivedAt"
        `;
        const [createdEvent] = await transaction<PrivacyRequestEventRow[]>`
          INSERT INTO privacy_request_events (
            event_id,
            correlation_id,
            case_id,
            actor_user_id,
            revision,
            state,
            deadline_at,
            action_code
          ) VALUES (
            ${request.eventId},
            ${request.correlationId},
            ${request.caseId},
            ${request.subjectUserId},
            1,
            'RECEIVED',
            NULL,
            NULL
          )
          RETURNING
            event_id AS "eventId",
            correlation_id AS "correlationId",
            case_id AS "caseId",
            actor_user_id AS "actorUserId",
            revision,
            state,
            deadline_at AS "deadlineAt",
            action_code AS "actionCode",
            occurred_at AS "occurredAt",
            ${request.subjectUserId}::uuid AS "subjectUserId"
        `;
        if (createdCase === undefined || createdEvent === undefined) {
          throw new Error("Privacy request case was not persisted.");
        }
        return toPrivacyCaseResult(createdCase, createdEvent, "CREATED");
      });
    },

    appendPrivacyRequestEvent(event: PrivacyRequestEventDraft) {
      assertPrivacyRequestEvent(event);
      return sql.begin(async (transaction) => {
        const [privacyCase] = await transaction<PrivacyCaseRow[]>`
          SELECT
            case_id AS "caseId",
            subject_user_id AS "subjectUserId",
            request_type AS "requestType",
            received_at AS "receivedAt"
          FROM privacy_request_cases
          WHERE case_id = ${event.caseId}
          FOR UPDATE
        `;
        if (privacyCase === undefined) {
          return Object.freeze({ status: "CASE_NOT_FOUND" as const });
        }

        const [existing] = await transaction<PrivacyRequestEventRow[]>`
          SELECT
            event.event_id AS "eventId",
            event.correlation_id AS "correlationId",
            event.case_id AS "caseId",
            event.actor_user_id AS "actorUserId",
            event.revision,
            event.state,
            event.deadline_at AS "deadlineAt",
            event.action_code AS "actionCode",
            event.occurred_at AS "occurredAt",
            privacy_case.subject_user_id AS "subjectUserId"
          FROM privacy_request_events AS event
          INNER JOIN privacy_request_cases AS privacy_case
            ON privacy_case.case_id = event.case_id
          WHERE event.event_id = ${event.eventId}
        `;
        if (existing !== undefined) {
          if (!samePrivacyRequestEvent(existing, event)) {
            throw new Error("Privacy request event idempotency conflict.");
          }
          return Object.freeze({
            event: toPrivacyRequestEvent(existing),
            status: "DEDUPLICATED" as const,
          });
        }

        const [current] = await transaction<PrivacyRequestEventRow[]>`
          SELECT
            event.event_id AS "eventId",
            event.correlation_id AS "correlationId",
            event.case_id AS "caseId",
            event.actor_user_id AS "actorUserId",
            event.revision,
            event.state,
            event.deadline_at AS "deadlineAt",
            event.action_code AS "actionCode",
            event.occurred_at AS "occurredAt",
            privacy_case.subject_user_id AS "subjectUserId"
          FROM privacy_request_events AS event
          INNER JOIN privacy_request_cases AS privacy_case
            ON privacy_case.case_id = event.case_id
          WHERE event.case_id = ${event.caseId}
          ORDER BY event.revision DESC
          LIMIT 1
        `;
        if (current === undefined) {
          throw new Error("Privacy request history is incomplete.");
        }
        if (current.revision !== event.expectedRevision) {
          return Object.freeze({
            currentRevision: current.revision,
            status: "STALE" as const,
          });
        }
        if (!canTransitionPrivacyRequest(current.state, event.state)) {
          return Object.freeze({
            currentRevision: current.revision,
            status: "INVALID_TRANSITION" as const,
          });
        }

        const [inserted] = await transaction<PrivacyRequestEventRow[]>`
          INSERT INTO privacy_request_events (
            event_id,
            correlation_id,
            case_id,
            actor_user_id,
            revision,
            state,
            deadline_at,
            action_code
          ) VALUES (
            ${event.eventId},
            ${event.correlationId},
            ${event.caseId},
            ${event.actorUserId},
            ${current.revision + 1},
            ${event.state},
            ${event.deadlineAt},
            ${event.actionCode}
          )
          RETURNING
            event_id AS "eventId",
            correlation_id AS "correlationId",
            case_id AS "caseId",
            actor_user_id AS "actorUserId",
            revision,
            state,
            deadline_at AS "deadlineAt",
            action_code AS "actionCode",
            occurred_at AS "occurredAt",
            ${privacyCase.subjectUserId}::uuid AS "subjectUserId"
        `;
        if (inserted === undefined) {
          throw new Error("Privacy request event was not persisted.");
        }
        return Object.freeze({
          event: toPrivacyRequestEvent(inserted),
          status: "APPENDED" as const,
        });
      });
    },
  });
}

async function lockConsent(
  transaction: TransactionSql,
  event: ConsentEventDraft,
): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtext(${event.subjectUserId}::text),
      hashtext(${event.purpose}::text)
    )
  `;
}

function toPolicy(row: PolicyRow): PrivacyPolicyVersion {
  return Object.freeze({ ...row });
}

function toConsentEvent(row: ConsentRow): ConsentEvent {
  return Object.freeze({ ...row });
}

function toRetentionPolicy(row: RetentionRow): RetentionPolicyVersion {
  return Object.freeze({ ...row });
}

function toPrivacyRequestEvent(
  row: PrivacyRequestEventRow,
): PrivacyRequestEvent {
  return Object.freeze({ ...row });
}

function toPrivacyCaseResult(
  privacyCase: PrivacyCaseRow,
  event: PrivacyRequestEventRow,
  status: "CREATED" | "DEDUPLICATED",
): CreatePrivacyRequestCaseResult {
  return Object.freeze({
    ...privacyCase,
    event: toPrivacyRequestEvent(event),
    status,
  });
}

function samePolicy(row: PolicyRow, draft: PrivacyPolicyVersionDraft): boolean {
  return (
    row.policyVersionId === draft.policyVersionId &&
    row.policyKind === draft.policyKind &&
    row.optionalConsentPurpose === draft.optionalConsentPurpose &&
    row.versionLabel === draft.versionLabel &&
    row.contentSha256 === draft.contentSha256 &&
    row.reviewState === draft.reviewState &&
    sameDate(row.effectiveAt, draft.effectiveAt) &&
    row.supersedesPolicyVersionId === draft.supersedesPolicyVersionId
  );
}

function sameConsentEvent(row: ConsentRow, draft: ConsentEventDraft): boolean {
  return (
    row.eventId === draft.eventId &&
    row.correlationId === draft.correlationId &&
    row.subjectUserId === draft.subjectUserId &&
    row.purpose === draft.purpose &&
    row.action === draft.action &&
    row.policyVersionId === draft.policyVersionId
  );
}

function sameRetention(
  row: RetentionRow,
  draft: RetentionPolicyVersionDraft,
): boolean {
  return (
    row.policyVersionId === draft.policyVersionId &&
    row.category === draft.category &&
    row.version === draft.version &&
    row.durationDays === draft.durationDays &&
    row.legalReviewState === draft.legalReviewState &&
    row.launchState === draft.launchState &&
    row.rationaleCode === draft.rationaleCode &&
    row.supersedesPolicyVersionId === draft.supersedesPolicyVersionId
  );
}

function samePrivacyRequestEvent(
  row: PrivacyRequestEventRow,
  draft: PrivacyRequestEventDraft,
): boolean {
  return (
    row.eventId === draft.eventId &&
    row.correlationId === draft.correlationId &&
    row.caseId === draft.caseId &&
    row.actorUserId === draft.actorUserId &&
    row.state === draft.state &&
    row.actionCode === draft.actionCode &&
    sameDate(row.deadlineAt, draft.deadlineAt)
  );
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.valueOf() === right?.valueOf();
}

function canTransitionPrivacyRequest(
  from: PrivacyRequestState,
  to: PrivacyRequestState,
): boolean {
  const transitions: Readonly<
    Record<PrivacyRequestState, readonly PrivacyRequestState[]>
  > = {
    RECEIVED: ["IDENTITY_VERIFICATION_PENDING", "VERIFIED"],
    IDENTITY_VERIFICATION_PENDING: ["VERIFIED", "REJECTED"],
    VERIFIED: ["IN_REVIEW"],
    IN_REVIEW: ["ACTION_REQUIRED", "COMPLETED", "REJECTED"],
    ACTION_REQUIRED: ["IN_REVIEW", "COMPLETED", "REJECTED"],
    COMPLETED: [],
    REJECTED: [],
  };
  return transitions[from].includes(to);
}

function assertPolicyVersion(policy: PrivacyPolicyVersionDraft): void {
  assertUuid(policy.policyVersionId, "policyVersionId");
  if (!PRIVACY_POLICY_KIND_VALUES.includes(policy.policyKind)) {
    throw new Error("Unsupported privacy policy kind.");
  }
  if (
    (policy.policyKind === "OPTIONAL_CONSENT_TEXT") !==
      (policy.optionalConsentPurpose !== null) ||
    (policy.optionalConsentPurpose !== null &&
      !OPTIONAL_CONSENT_PURPOSE_VALUES.includes(policy.optionalConsentPurpose))
  ) {
    throw new Error(
      "Policy kind and optional consent purpose are inconsistent.",
    );
  }
  if (!versionLabelPattern.test(policy.versionLabel)) {
    throw new Error("Privacy policy version label is invalid.");
  }
  if (!hashPattern.test(policy.contentSha256)) {
    throw new Error("Privacy policy content hash is invalid.");
  }
  if (!PRIVACY_REVIEW_STATE_VALUES.includes(policy.reviewState)) {
    throw new Error("Privacy policy review state is invalid.");
  }
  if (
    (policy.reviewState === "UNRESOLVED" && policy.effectiveAt !== null) ||
    (policy.reviewState === "APPROVED" &&
      (policy.effectiveAt === null ||
        !Number.isFinite(policy.effectiveAt.valueOf())))
  ) {
    throw new Error("Privacy policy review/effective state is inconsistent.");
  }
  assertNullableUuid(
    policy.supersedesPolicyVersionId,
    "supersedesPolicyVersionId",
  );
}

function assertConsentEvent(event: ConsentEventDraft): void {
  assertUuid(event.eventId, "eventId");
  assertUuid(event.correlationId, "correlationId");
  assertUuid(event.subjectUserId, "subjectUserId");
  assertUuid(event.policyVersionId, "policyVersionId");
  if (!OPTIONAL_CONSENT_PURPOSE_VALUES.includes(event.purpose)) {
    throw new Error("Consent purpose is not genuinely optional.");
  }
  if (!CONSENT_ACTION_VALUES.includes(event.action)) {
    throw new Error("Consent action is invalid.");
  }
  assertExpectedRevision(event.expectedRevision);
}

function assertRetentionPolicy(policy: RetentionPolicyVersionDraft): void {
  assertUuid(policy.policyVersionId, "policyVersionId");
  assertNullableUuid(
    policy.supersedesPolicyVersionId,
    "supersedesPolicyVersionId",
  );
  if (!RETENTION_CATEGORY_VALUES.includes(policy.category)) {
    throw new Error("Retention category is invalid.");
  }
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new Error("Retention policy version must be positive.");
  }
  if (!PRIVACY_REVIEW_STATE_VALUES.includes(policy.legalReviewState)) {
    throw new Error("Retention legal review state is invalid.");
  }
  if (!RETENTION_LAUNCH_STATE_VALUES.includes(policy.launchState)) {
    throw new Error("Retention launch state is invalid.");
  }
  if (!actionCodePattern.test(policy.rationaleCode)) {
    throw new Error("Retention rationale must be a safe code.");
  }
  if (
    policy.legalReviewState === "UNRESOLVED"
      ? policy.launchState !== "BLOCKED" || policy.durationDays !== null
      : policy.durationDays === null ||
        !Number.isSafeInteger(policy.durationDays) ||
        policy.durationDays < 1 ||
        policy.durationDays > 36_500
  ) {
    throw new Error("Retention policy is not production-safe.");
  }
}

function assertPrivacyRequestCase(request: PrivacyRequestCaseDraft): void {
  assertUuid(request.caseId, "caseId");
  assertUuid(request.eventId, "eventId");
  assertUuid(request.correlationId, "correlationId");
  assertUuid(request.subjectUserId, "subjectUserId");
  if (!PRIVACY_REQUEST_TYPE_VALUES.includes(request.requestType)) {
    throw new Error("Privacy request type is invalid.");
  }
}

function assertPrivacyRequestEvent(event: PrivacyRequestEventDraft): void {
  assertUuid(event.caseId, "caseId");
  assertUuid(event.eventId, "eventId");
  assertUuid(event.correlationId, "correlationId");
  assertUuid(event.actorUserId, "actorUserId");
  assertExpectedRevision(event.expectedRevision);
  if (
    !PRIVACY_REQUEST_STATE_VALUES.includes(event.state) ||
    event.state === "RECEIVED"
  ) {
    throw new Error("Privacy request transition state is invalid.");
  }
  if (event.actionCode === null || !actionCodePattern.test(event.actionCode)) {
    throw new Error("Privacy request action must be a minimized safe code.");
  }
  if (
    event.deadlineAt !== null &&
    !Number.isFinite(event.deadlineAt.valueOf())
  ) {
    throw new Error("Privacy request deadline is invalid.");
  }
}

function assertExpectedRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Expected revision must be a non-negative integer.");
  }
}

function assertNullableUuid(value: string | null, field: string): void {
  if (value !== null) assertUuid(value, field);
}

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new Error(`${field} must be a UUID.`);
}
