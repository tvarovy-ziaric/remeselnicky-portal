import type { UserId } from "@portal/domain";

export const DATA_CLASSIFICATION_VALUES = Object.freeze([
  "PUBLIC",
  "INTERNAL",
  "PRIVATE",
  "SENSITIVE_OPERATIONAL",
] as const);
export type DataClassification = (typeof DATA_CLASSIFICATION_VALUES)[number];

export const PRIVACY_POLICY_KIND_VALUES = Object.freeze([
  "PRIVACY_NOTICE",
  "TERMS_OF_SERVICE",
  "OPTIONAL_CONSENT_TEXT",
  "PURPOSE_LEGAL_BASIS_REGISTER",
  "DATA_PROCESSING_INVENTORY",
] as const);
export type PrivacyPolicyKind = (typeof PRIVACY_POLICY_KIND_VALUES)[number];

export const PRIVACY_REVIEW_STATE_VALUES = Object.freeze([
  "UNRESOLVED",
  "APPROVED",
] as const);
export type PrivacyReviewState = (typeof PRIVACY_REVIEW_STATE_VALUES)[number];

export const OPTIONAL_CONSENT_PURPOSE_VALUES = Object.freeze([
  "PORTFOLIO_PROPERTY_PHOTO_PUBLICATION",
  "NON_ESSENTIAL_ANALYTICS",
  "MARKETING_EMAIL",
] as const);
export type OptionalConsentPurpose =
  (typeof OPTIONAL_CONSENT_PURPOSE_VALUES)[number];

export const CONSENT_ACTION_VALUES = Object.freeze([
  "GRANTED",
  "WITHDRAWN",
] as const);
export type ConsentAction = (typeof CONSENT_ACTION_VALUES)[number];

export const RETENTION_CATEGORY_VALUES = Object.freeze([
  "ACCOUNT_CORE",
  "ABANDONED_DRAFT",
  "PRE_JOB_CONVERSATION",
  "COMMERCIAL_JOB_RECORD",
  "PRIVATE_JOB_MEDIA",
  "PUBLIC_PORTFOLIO_MEDIA",
  "CREDENTIAL_EVIDENCE",
  "REJECTED_CREDENTIAL",
  "MALWARE_QUARANTINE",
  "DISPUTE_EVIDENCE",
  "MODERATION_SECURITY",
  "RISK_FLAG",
  "APPLICATION_LOG",
  "NOTIFICATION_DELIVERY",
  "AUDIT_EVENT",
  "PRIVACY_REQUEST_CASE",
  "BACKUP",
] as const);
export type RetentionCategory = (typeof RETENTION_CATEGORY_VALUES)[number];

export const RETENTION_LAUNCH_STATE_VALUES = Object.freeze([
  "BLOCKED",
  "READY",
] as const);
export type RetentionLaunchState =
  (typeof RETENTION_LAUNCH_STATE_VALUES)[number];

export const PRIVACY_REQUEST_TYPE_VALUES = Object.freeze([
  "ACCESS",
  "RECTIFICATION",
  "ERASURE",
  "RESTRICTION",
  "PORTABILITY",
  "OBJECTION",
  "ACCOUNT_CLOSURE",
] as const);
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPE_VALUES)[number];

export const PRIVACY_REQUEST_STATE_VALUES = Object.freeze([
  "RECEIVED",
  "IDENTITY_VERIFICATION_PENDING",
  "VERIFIED",
  "IN_REVIEW",
  "ACTION_REQUIRED",
  "COMPLETED",
  "REJECTED",
] as const);
export type PrivacyRequestState = (typeof PRIVACY_REQUEST_STATE_VALUES)[number];

export interface PrivacyPolicyVersionDraft {
  readonly contentSha256: string;
  readonly effectiveAt: Date | null;
  readonly optionalConsentPurpose: OptionalConsentPurpose | null;
  readonly policyKind: PrivacyPolicyKind;
  readonly policyVersionId: string;
  readonly reviewState: PrivacyReviewState;
  readonly supersedesPolicyVersionId: string | null;
  readonly versionLabel: string;
}

export interface PrivacyPolicyVersion extends PrivacyPolicyVersionDraft {
  readonly createdAt: Date;
}

export type AppendPolicyVersionResult = Readonly<{
  readonly policy: PrivacyPolicyVersion;
  readonly status: "APPENDED" | "DEDUPLICATED";
}>;

export interface ConsentEventDraft {
  readonly action: ConsentAction;
  readonly correlationId: string;
  readonly eventId: string;
  readonly expectedRevision: number;
  readonly policyVersionId: string;
  readonly purpose: OptionalConsentPurpose;
  readonly subjectUserId: UserId;
}

export interface ConsentEvent extends Omit<
  ConsentEventDraft,
  "expectedRevision"
> {
  readonly occurredAt: Date;
  readonly revision: number;
}

export type AppendConsentEventResult =
  | Readonly<{
      readonly event: ConsentEvent;
      readonly status: "APPENDED" | "DEDUPLICATED";
    }>
  | Readonly<{
      readonly currentRevision: number;
      readonly status: "STALE" | "UNCHANGED";
    }>
  | Readonly<{ readonly status: "POLICY_NOT_APPROVED" }>;

export interface RetentionPolicyVersionDraft {
  readonly category: RetentionCategory;
  readonly durationDays: number | null;
  readonly legalReviewState: PrivacyReviewState;
  readonly policyVersionId: string;
  readonly rationaleCode: string;
  readonly supersedesPolicyVersionId: string | null;
  readonly version: number;
  readonly launchState: RetentionLaunchState;
}

export interface RetentionPolicyVersion extends RetentionPolicyVersionDraft {
  readonly createdAt: Date;
}

export type AppendRetentionPolicyResult = Readonly<{
  readonly policy: RetentionPolicyVersion;
  readonly status: "APPENDED" | "DEDUPLICATED";
}>;

export interface PrivacyRequestCaseDraft {
  readonly caseId: string;
  readonly correlationId: string;
  readonly eventId: string;
  readonly requestType: PrivacyRequestType;
  readonly subjectUserId: UserId;
}

export interface PrivacyRequestEventDraft {
  readonly actionCode: string | null;
  readonly actorUserId: UserId;
  readonly caseId: string;
  readonly correlationId: string;
  readonly deadlineAt: Date | null;
  readonly eventId: string;
  readonly expectedRevision: number;
  readonly state: PrivacyRequestState;
}

export interface PrivacyRequestEvent extends Omit<
  PrivacyRequestEventDraft,
  "expectedRevision"
> {
  readonly occurredAt: Date;
  readonly revision: number;
  readonly subjectUserId: UserId;
}

export type CreatePrivacyRequestCaseResult = Readonly<{
  readonly caseId: string;
  readonly event: PrivacyRequestEvent;
  readonly receivedAt: Date;
  readonly requestType: PrivacyRequestType;
  readonly status: "CREATED" | "DEDUPLICATED";
  readonly subjectUserId: UserId;
}>;

export type AppendPrivacyRequestEventResult =
  | Readonly<{
      readonly event: PrivacyRequestEvent;
      readonly status: "APPENDED" | "DEDUPLICATED";
    }>
  | Readonly<{
      readonly currentRevision: number;
      readonly status: "INVALID_TRANSITION" | "STALE";
    }>
  | Readonly<{ readonly status: "CASE_NOT_FOUND" }>;

export interface PrivacyAuditProjectionEvent {
  readonly action:
    | "privacy.consent.granted"
    | "privacy.consent.withdrawn"
    | "privacy.request.opened"
    | "privacy.request.transitioned";
  readonly actorUserId: UserId;
  readonly correlationId: string;
  readonly eventId: string;
  readonly outcome: string;
  readonly subjectUserId: UserId;
  readonly targetId: string;
  readonly targetType: "CONSENT" | "PRIVACY_REQUEST";
}

export interface PrivacyAuditIntegrationPort {
  /** Idempotent secondary projection; privacy history remains authoritative. */
  project(event: PrivacyAuditProjectionEvent): Promise<void>;
}

export interface PrivacyRepository {
  appendConsentEvent(
    event: ConsentEventDraft,
  ): Promise<AppendConsentEventResult>;
  appendPolicyVersion(
    policy: PrivacyPolicyVersionDraft,
  ): Promise<AppendPolicyVersionResult>;
  appendPrivacyRequestEvent(
    event: PrivacyRequestEventDraft,
  ): Promise<AppendPrivacyRequestEventResult>;
  appendRetentionPolicyVersion(
    policy: RetentionPolicyVersionDraft,
  ): Promise<AppendRetentionPolicyResult>;
  createPrivacyRequestCase(
    request: PrivacyRequestCaseDraft,
  ): Promise<CreatePrivacyRequestCaseResult>;
  findLatestRetentionPolicy(
    category: RetentionCategory,
  ): Promise<RetentionPolicyVersion | null>;
}
