import type { UserId } from "@portal/domain";
import type { PrivacyRequestState } from "@portal/privacy";
import type { Sql, TransactionSql } from "postgres";

export const PRIVACY_SUBJECT_EXPORT_SCHEMA_VERSION = "1.0";
export const PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION = 10_000;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const exportableStates = new Set<PrivacyRequestState>([
  "VERIFIED",
  "IN_REVIEW",
  "ACTION_REQUIRED",
  "COMPLETED",
]);

interface ExportCaseRow {
  readonly caseId: string;
  readonly requestType: "ACCESS" | "PORTABILITY";
  readonly revision: number;
  readonly state: PrivacyRequestState;
}
interface AccountRow {
  readonly accountState: "ACTIVE" | "DEACTIVATED" | "SUSPENDED";
  readonly accountStateChangedAt: Date;
  readonly adultAttestedAt: Date;
  readonly createdAt: Date;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly phone: string | null;
  readonly phoneVerifiedAt: Date | null;
  readonly userId: UserId;
}
interface CustomerProfileRow {
  readonly createdAt: Date;
  readonly profileId: string;
  readonly updatedAt: Date;
}
interface CraftsmanProfileRow {
  readonly about: string | null;
  readonly companyRegistrationNumber: string | null;
  readonly companyRegistrationVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly identityVerifiedAt: Date | null;
  readonly nickname: string | null;
  readonly officialCompanyName: string | null;
  readonly profileId: string;
  readonly profileType: "COMPANY" | "INDIVIDUAL";
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
  readonly revision: number;
  readonly updatedAt: Date;
}
interface ConsentRow {
  readonly action: "GRANTED" | "WITHDRAWN";
  readonly occurredAt: Date;
  readonly policyVersionId: string;
  readonly purpose: string;
  readonly revision: number;
}
interface RequestHistoryRow {
  readonly actionCode: string | null;
  readonly caseId: string;
  readonly deadlineAt: Date | null;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly requestType: string;
  readonly revision: number;
  readonly state: string;
}
interface DraftRow {
  readonly jobRequestId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestRevision: number;
  readonly savedAt: Date;
  readonly sectionKey: string;
  readonly sectionSchemaVersion: number;
}
interface MessageRow {
  readonly body: string;
  readonly conversationId: string;
  readonly createdAt: Date;
  readonly messageId: string;
  readonly sequence: string;
}
interface MediaRow {
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly declaredContentType: string;
  readonly displayFilename: string | null;
  readonly kind: string;
  readonly mediaAssetId: string;
  readonly ownerUserId: UserId;
  readonly provenanceEntityId: string | null;
  readonly provenanceEntityRevision: number | null;
  readonly provenanceEntityType: string | null;
  readonly purpose: string;
  readonly readyAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly status: string;
  readonly uploadedByUserId: UserId;
}

export interface PrivacySubjectExportDocument {
  readonly account: Readonly<{
    readonly accountState: AccountRow["accountState"];
    readonly accountStateChangedAt: string;
    readonly adultAttestedAt: string;
    readonly createdAt: string;
    readonly email: string;
    readonly emailVerifiedAt: string | null;
    readonly phone: string | null;
    readonly phoneVerifiedAt: string | null;
    readonly userId: UserId;
  }>;
  readonly consentHistory: readonly Readonly<{
    action: ConsentRow["action"];
    occurredAt: string;
    policyVersionId: string;
    purpose: string;
    revision: number;
  }>[];
  readonly customerProfile: Readonly<{
    createdAt: string;
    profileId: string;
    updatedAt: string;
  }> | null;
  readonly craftsmanProfile: Readonly<{
    about: string | null;
    companyRegistrationNumber: string | null;
    companyRegistrationVerifiedAt: string | null;
    createdAt: string;
    identityVerifiedAt: string | null;
    nickname: string | null;
    officialCompanyName: string | null;
    profileId: string;
    profileType: CraftsmanProfileRow["profileType"];
    realFirstName: string | null;
    realLastName: string | null;
    revision: number;
    updatedAt: string;
  }> | null;
  readonly exportCase: Readonly<{
    caseId: string;
    requestRevision: number;
    requestState: PrivacyRequestState;
    requestType: "ACCESS" | "PORTABILITY";
  }>;
  readonly generatedAt: string;
  readonly jobRequestDraftHistory: readonly Readonly<{
    jobRequestId: string;
    payload: Readonly<Record<string, unknown>>;
    requestRevision: number;
    savedAt: string;
    sectionKey: string;
    sectionSchemaVersion: number;
  }>[];
  readonly mediaManifest: readonly Readonly<{
    byteSize: number;
    createdAt: string;
    declaredContentType: string;
    displayFilename: string | null;
    kind: string;
    mediaAssetId: string;
    provenanceEntityId: string | null;
    provenanceEntityRevision: number | null;
    provenanceEntityType: string | null;
    purpose: string;
    readyAt: string | null;
    rejectedAt: string | null;
    relationship: "OWNER" | "OWNER_AND_UPLOADER" | "UPLOADER";
    status: string;
  }>[];
  readonly privacyRequestHistory: readonly Readonly<{
    actionCode: string | null;
    caseId: string;
    deadlineAt: string | null;
    occurredAt: string;
    receivedAt: string;
    requestType: string;
    revision: number;
    state: string;
  }>[];
  readonly schemaVersion: typeof PRIVACY_SUBJECT_EXPORT_SCHEMA_VERSION;
  readonly scope: Readonly<{
    coverage: "BASE_BUNDLE_REQUIRES_CASE_REVIEW";
    excludedSecurityMaterial: readonly string[];
    includedSections: readonly string[];
    requiredCaseReviewSupplements: readonly string[];
  }>;
  readonly subjectAuthoredConversationMessages: readonly Readonly<{
    body: string;
    conversationId: string;
    createdAt: string;
    messageId: string;
    sequence: string;
  }>[];
}

export type CreatePrivacySubjectExportResult =
  | Readonly<{
      readonly document: PrivacySubjectExportDocument;
      readonly status: "READY";
    }>
  | Readonly<{
      readonly status:
        | "ASSISTED_EXPORT_REQUIRED"
        | "IDENTITY_VERIFICATION_REQUIRED"
        | "NOT_AVAILABLE"
        | "NOT_FOUND";
    }>;

export interface PrivacySubjectExportRepository {
  createForSubject(input: {
    readonly caseId: string;
    readonly subjectUserId: UserId;
  }): Promise<CreatePrivacySubjectExportResult>;
}

export function createPrivacySubjectExportRepository(
  sql: Sql,
): PrivacySubjectExportRepository {
  return Object.freeze({
    async createForSubject(input: {
      readonly caseId: string;
      readonly subjectUserId: UserId;
    }) {
      validId(input.caseId);
      validId(input.subjectUserId);
      return sql.begin(async (transaction) => {
        await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        return createWithinSnapshot(transaction, input);
      });
    },
  });
}

async function createWithinSnapshot(
  sql: TransactionSql,
  input: { readonly caseId: string; readonly subjectUserId: UserId },
): Promise<CreatePrivacySubjectExportResult> {
  const [exportCase] = await sql<ExportCaseRow[]>`
    SELECT case_id AS "caseId", request_type::text AS "requestType",
      revision, state::text
    FROM current_privacy_request_cases
    WHERE case_id = ${input.caseId}
      AND subject_user_id = ${input.subjectUserId}
      AND request_type IN ('ACCESS', 'PORTABILITY')`;
  if (exportCase === undefined) return { status: "NOT_FOUND" };
  if (!exportableStates.has(exportCase.state))
    return {
      status:
        exportCase.state === "REJECTED"
          ? "NOT_AVAILABLE"
          : "IDENTITY_VERIFICATION_REQUIRED",
    };

  const [account] = await sql<AccountRow[]>`
    SELECT user_account.id AS "userId",
      user_account.account_state::text AS "accountState",
      user_account.account_state_changed_at AS "accountStateChangedAt",
      user_account.created_at AS "createdAt",
      credential.normalized_email AS email,
      credential.email_verified_at AS "emailVerifiedAt",
      credential.normalized_phone AS phone,
      credential.phone_verified_at AS "phoneVerifiedAt",
      credential.adult_attested_at AS "adultAttestedAt"
    FROM users user_account
    JOIN auth_credentials credential ON credential.user_id = user_account.id
    WHERE user_account.id = ${input.subjectUserId}`;
  if (account === undefined) return { status: "NOT_FOUND" };

  const customerProfiles = await sql<CustomerProfileRow[]>`
    SELECT id AS "profileId", created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM customer_profiles WHERE owner_user_id = ${input.subjectUserId}`;
  const craftsmanProfiles = await sql<CraftsmanProfileRow[]>`
    SELECT id AS "profileId", profile_type::text AS "profileType",
      real_first_name AS "realFirstName", real_last_name AS "realLastName",
      nickname, official_company_name AS "officialCompanyName",
      company_registration_number AS "companyRegistrationNumber", about,
      identity_verified_at AS "identityVerifiedAt",
      company_registration_verified_at AS "companyRegistrationVerifiedAt",
      revision, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM craftsman_profiles WHERE owner_user_id = ${input.subjectUserId}`;
  const consents = await sql<ConsentRow[]>`
    SELECT purpose::text, action::text, policy_version_id AS "policyVersionId",
      revision, occurred_at AS "occurredAt"
    FROM privacy_consent_events
    WHERE subject_user_id = ${input.subjectUserId}
    ORDER BY purpose, revision`;
  const requests = await sql<RequestHistoryRow[]>`
    SELECT request.case_id AS "caseId", request.request_type::text AS "requestType",
      request.received_at AS "receivedAt", event.revision,
      event.state::text, event.deadline_at AS "deadlineAt",
      event.action_code AS "actionCode", event.occurred_at AS "occurredAt"
    FROM privacy_request_cases request
    JOIN privacy_request_events event ON event.case_id = request.case_id
    WHERE request.subject_user_id = ${input.subjectUserId}
    ORDER BY request.received_at, request.case_id, event.revision`;
  const drafts = await sql<DraftRow[]>`
    SELECT section.job_request_id AS "jobRequestId",
      section.request_revision AS "requestRevision",
      section.section_key AS "sectionKey",
      section.section_schema_version AS "sectionSchemaVersion",
      section.payload, section.saved_at AS "savedAt"
    FROM job_request_draft_section_revisions section
    JOIN job_requests request ON request.id = section.job_request_id
    JOIN customer_profiles customer ON customer.id = request.customer_profile_id
    WHERE customer.owner_user_id = ${input.subjectUserId}
    ORDER BY section.job_request_id, section.request_revision
    LIMIT ${PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION + 1}`;
  const messages = await sql<MessageRow[]>`
    SELECT id AS "messageId", conversation_id AS "conversationId",
      sequence::text, body, created_at AS "createdAt"
    FROM conversation_timeline_entries
    WHERE entry_kind = 'HUMAN_MESSAGE'
      AND author_user_id = ${input.subjectUserId}
    ORDER BY conversation_id, sequence
    LIMIT ${PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION + 1}`;
  const media = await sql<MediaRow[]>`
    SELECT id AS "mediaAssetId", owner_user_id AS "ownerUserId",
      uploaded_by_user_id AS "uploadedByUserId", kind::text, purpose::text,
      status::text, declared_content_type AS "declaredContentType",
      display_filename AS "displayFilename", byte_size AS "byteSize",
      provenance_entity_type::text AS "provenanceEntityType",
      provenance_entity_id AS "provenanceEntityId",
      provenance_entity_revision AS "provenanceEntityRevision",
      created_at AS "createdAt", ready_at AS "readyAt",
      rejected_at AS "rejectedAt"
    FROM media_assets
    WHERE owner_user_id = ${input.subjectUserId}
      OR uploaded_by_user_id = ${input.subjectUserId}
    ORDER BY created_at, id
    LIMIT ${PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION + 1}`;
  if (
    drafts.length > PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION ||
    messages.length > PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION ||
    media.length > PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION
  )
    return { status: "ASSISTED_EXPORT_REQUIRED" };
  const [clock] = await sql<{ readonly generatedAt: Date }[]>`
    SELECT transaction_timestamp() AS "generatedAt"`;
  if (clock === undefined) throw new Error("Privacy export clock unavailable.");

  return {
    document: Object.freeze({
      account: Object.freeze({
        accountState: account.accountState,
        accountStateChangedAt: iso(account.accountStateChangedAt),
        adultAttestedAt: iso(account.adultAttestedAt),
        createdAt: iso(account.createdAt),
        email: account.email,
        emailVerifiedAt: nullableIso(account.emailVerifiedAt),
        phone: account.phone,
        phoneVerifiedAt: nullableIso(account.phoneVerifiedAt),
        userId: account.userId,
      }),
      consentHistory: Object.freeze(
        consents.map((row) =>
          Object.freeze({
            action: row.action,
            occurredAt: iso(row.occurredAt),
            policyVersionId: row.policyVersionId,
            purpose: row.purpose,
            revision: row.revision,
          }),
        ),
      ),
      customerProfile: optionalCustomerProfile(customerProfiles[0]),
      craftsmanProfile: optionalCraftsmanProfile(craftsmanProfiles[0]),
      exportCase: Object.freeze({
        caseId: exportCase.caseId,
        requestRevision: exportCase.revision,
        requestState: exportCase.state,
        requestType: exportCase.requestType,
      }),
      generatedAt: iso(clock.generatedAt),
      jobRequestDraftHistory: Object.freeze(
        drafts.map((row) =>
          Object.freeze({
            jobRequestId: row.jobRequestId,
            payload: Object.freeze(row.payload),
            requestRevision: row.requestRevision,
            savedAt: iso(row.savedAt),
            sectionKey: row.sectionKey,
            sectionSchemaVersion: row.sectionSchemaVersion,
          }),
        ),
      ),
      mediaManifest: Object.freeze(
        media.map((row) =>
          Object.freeze({
            byteSize: row.byteSize,
            createdAt: iso(row.createdAt),
            declaredContentType: row.declaredContentType,
            displayFilename: row.displayFilename,
            kind: row.kind,
            mediaAssetId: row.mediaAssetId,
            provenanceEntityId: row.provenanceEntityId,
            provenanceEntityRevision: row.provenanceEntityRevision,
            provenanceEntityType: row.provenanceEntityType,
            purpose: row.purpose,
            readyAt: nullableIso(row.readyAt),
            rejectedAt: nullableIso(row.rejectedAt),
            relationship:
              row.ownerUserId === input.subjectUserId &&
              row.uploadedByUserId === input.subjectUserId
                ? "OWNER_AND_UPLOADER"
                : row.ownerUserId === input.subjectUserId
                  ? "OWNER"
                  : "UPLOADER",
            status: row.status,
          }),
        ),
      ),
      privacyRequestHistory: Object.freeze(
        requests.map((row) =>
          Object.freeze({
            actionCode: row.actionCode,
            caseId: row.caseId,
            deadlineAt: nullableIso(row.deadlineAt),
            occurredAt: iso(row.occurredAt),
            receivedAt: iso(row.receivedAt),
            requestType: row.requestType,
            revision: row.revision,
            state: row.state,
          }),
        ),
      ),
      schemaVersion: PRIVACY_SUBJECT_EXPORT_SCHEMA_VERSION,
      scope: Object.freeze({
        coverage: "BASE_BUNDLE_REQUIRES_CASE_REVIEW",
        excludedSecurityMaterial: Object.freeze([
          "AUTHENTICATION_SECRET_HASHES_AND_TOKENS",
          "SESSION_AND_MFA_IDENTIFIERS",
          "INTERNAL_ADMIN_SECURITY_AND_RISK_DATA",
          "STORAGE_KEYS_HASHES_AND_PROVIDER_REFERENCES",
          "OTHER_PERSON_MESSAGE_CONTENT",
        ]),
        includedSections: Object.freeze([
          "ACCOUNT_AND_VERIFIED_CONTACT",
          "CUSTOMER_PROFILE",
          "CRAFTSMAN_PROFILE",
          "OPTIONAL_CONSENT_HISTORY",
          "PRIVACY_REQUEST_HISTORY",
          "JOB_REQUEST_DRAFT_HISTORY",
          "SUBJECT_AUTHORED_CONVERSATION_MESSAGES",
          "SUBJECT_MEDIA_MANIFEST",
        ]),
        requiredCaseReviewSupplements: Object.freeze([
          "SHARED_JOB_AND_COMMERCIAL_RECORDS",
          "OTHER_PARTY_SHARED_CONTENT",
          "RAW_MEDIA_BINARY_FILES",
          "EXTERNAL_PROCESSOR_DATA",
        ]),
      }),
      subjectAuthoredConversationMessages: Object.freeze(
        messages.map((row) =>
          Object.freeze({
            body: row.body,
            conversationId: row.conversationId,
            createdAt: iso(row.createdAt),
            messageId: row.messageId,
            sequence: row.sequence,
          }),
        ),
      ),
    }),
    status: "READY",
  };
}

function optionalCustomerProfile(row: CustomerProfileRow | undefined) {
  return row === undefined
    ? null
    : Object.freeze({
        createdAt: iso(row.createdAt),
        profileId: row.profileId,
        updatedAt: iso(row.updatedAt),
      });
}

function optionalCraftsmanProfile(row: CraftsmanProfileRow | undefined) {
  return row === undefined
    ? null
    : Object.freeze({
        about: row.about,
        companyRegistrationNumber: row.companyRegistrationNumber,
        companyRegistrationVerifiedAt: nullableIso(
          row.companyRegistrationVerifiedAt,
        ),
        createdAt: iso(row.createdAt),
        identityVerifiedAt: nullableIso(row.identityVerifiedAt),
        nickname: row.nickname,
        officialCompanyName: row.officialCompanyName,
        profileId: row.profileId,
        profileType: row.profileType,
        realFirstName: row.realFirstName,
        realLastName: row.realLastName,
        revision: row.revision,
        updatedAt: iso(row.updatedAt),
      });
}

function iso(value: Date): string {
  return value.toISOString();
}
function nullableIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
function validId(value: string): void {
  if (!uuid.test(value)) throw new TypeError("Invalid privacy export ID.");
}
