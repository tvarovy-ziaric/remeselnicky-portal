import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createAdminAccessRepository } from "./admin-auth-repository.js";
import type { AdminAccessRepository } from "@portal/admin-auth";
import { createAuditRepository } from "./audit-repository.js";
import type { AuditRepository } from "@portal/audit";
import {
  createAuthRepository,
  type AuthRepository,
} from "./auth-repository.js";
import {
  createEmailVerificationRepository,
  type EmailVerificationRepository,
} from "./email-verification-repository.js";
import {
  createMediaRepository,
  type MediaRepository,
} from "./media-repository.js";
import { createPrivateMediaDeliveryRepository } from "./media-delivery-repository.js";
import {
  createPortfolioPublicationRepository,
  createPublicPortfolioDeliveryRepository,
} from "./portfolio-publication-repository.js";
import type {
  ConversationAttachmentUploadAuthorization,
  JobRequestMediaUploadAuthorization,
  MediaEntityAccessResolver,
  PortfolioPublicationRepository,
  PrivateMediaDeliveryRepository,
  PublicPortfolioDeliveryRepository,
} from "@portal/media";
import {
  createPhoneVerificationRepository,
  type PhoneVerificationRepository,
} from "./phone-verification-repository.js";
import {
  createOutboxRepository,
  type OutboxRepository,
} from "./outbox-repository.js";
import {
  createNotificationRepository,
  type NotificationRepository,
} from "./notification-repository.js";
import { createProfessionTaxonomyRepository } from "./taxonomy-repository.js";
import type { ProfessionTaxonomyPersistence } from "@portal/taxonomy";
import { createCraftsmanProfessionRepository } from "./craftsman-profession-repository.js";
import type { CraftsmanProfessionPersistence } from "@portal/domain";
import { createCraftsmanServiceAreaRepository } from "./craftsman-service-area-repository.js";
import type { CraftsmanServiceAreaPersistence } from "@portal/domain";
import { createCraftsmanCapabilityRepository } from "./craftsman-capability-repository.js";
import type { CraftsmanCapabilityPersistence } from "@portal/domain";
import { createSkillCatalogRepository } from "./skill-catalog-repository.js";
import type { SkillCatalogRepository } from "./skill-catalog-repository.js";
import { createIndicativePricingRepository } from "./indicative-pricing-repository.js";
import type { IndicativePricingPersistence } from "@portal/domain";
import { createPortfolioProjectRepository } from "./portfolio-project-repository.js";
import type { PortfolioProjectPersistence } from "@portal/domain";
import { createPortfolioCollaborationRepository } from "./portfolio-collaboration-repository.js";
import type { PortfolioCollaborationPersistence } from "@portal/domain";
import { createPortfolioProjectPhotoRepository } from "./portfolio-project-media-repository.js";
import type { PortfolioProjectPhotoPersistence } from "@portal/domain";
import { createFeaturedProjectRepository } from "./featured-project-repository.js";
import type { FeaturedProjectPersistence } from "@portal/domain";
import { createCraftsmanExperienceRepository } from "./craftsman-experience-repository.js";
import type { CraftsmanExperiencePersistence } from "@portal/domain";
import { createCraftsmanAvailabilityRepository } from "./craftsman-availability-repository.js";
import type { CraftsmanAvailabilityPersistence } from "@portal/domain";
import { createCraftsmanPublicationRepository } from "./craftsman-publication-repository.js";
import type { CraftsmanPublicationPersistence } from "@portal/domain";
import { createPublicCraftsmanProfileRepository } from "./public-craftsman-profile-repository.js";
import { createCraftsmanSearchReadModelRepository } from "./craftsman-search-read-model-repository.js";
import { createCraftsmanDistanceRepository } from "./craftsman-distance-repository.js";
import { createCraftsmanServiceAreaMatchRepository } from "./craftsman-service-area-match-repository.js";
import { createCraftsmanAvailabilityMatchRepository } from "./craftsman-availability-match-repository.js";
import { createCraftsmanTrustEvidenceRepository } from "./craftsman-trust-evidence-repository.js";
import { createPublicSearchCardSource } from "./public-search-card-source.js";
import type {
  CraftsmanAvailabilityMatchPersistence,
  CraftsmanDistancePersistence,
  CraftsmanSearchReadModelPersistence,
  CraftsmanServiceAreaMatchPersistence,
  CraftsmanTrustEvidencePersistence,
  PublicCraftsmanProfilePersistence,
} from "@portal/domain";
import { createTaxonomyAutocompleteRepository } from "./taxonomy-autocomplete-repository.js";
import {
  createMunicipalityAutocompleteRepository,
  type MunicipalityAutocompletePersistence,
} from "./municipality-autocomplete-repository.js";
import { createCredentialQualificationRepository } from "./credential-qualification-repository.js";
import type {
  CredentialQualificationPolicyPersistence,
  TaxonomyAutocompletePersistence,
} from "@portal/search";
import {
  createCredentialClaimRepository,
  type CredentialClaimRepository,
} from "./credential-claim-repository.js";
import { createPrivacyRepository } from "./privacy-repository.js";
import type { PrivacyRepository } from "@portal/privacy";
import { createCustomerProfileRepository } from "./customer-profile-repository.js";
import { createCustomerShortlistRepository } from "./customer-shortlist-repository.js";
import { createJobRequestRepository } from "./job-request-repository.js";
import { createJobRequestDraftRepository } from "./job-request-draft-repository.js";
import { createJobRequestVersionRepository } from "./job-request-version-repository.js";
import { createJobRequestLifecycleRepository } from "./job-request-lifecycle-repository.js";
import { createJobInvitationRepository } from "./job-invitation-repository.js";
import { createJobInvitationReminderRepository } from "./job-invitation-notification-repository.js";
import { createConversationRepository } from "./conversation-repository.js";
import { createConversationChatRepository } from "./conversation-chat-repository.js";
import { createQuoteRepository } from "./quote-repository.js";
import { createStructuredQuoteRepository } from "./quote-structured-repository.js";
import {
  createConversationAttachmentMediaAccessResolver,
  createConversationAttachmentUploadAuthorization,
} from "./conversation-attachment-repository.js";
import type { JobInvitationReminderStore } from "@portal/notifications";
import { createJobRequestMediaUploadAuthorization } from "./job-request-media-repository.js";
import { createCraftsmanProfileRepository } from "./craftsman-profile-repository.js";
import type {
  CraftsmanProfilePersistence,
  CustomerShortlistPersistence,
  CustomerProfilePersistence,
  JobRequestPersistence,
  JobRequestDraftPersistence,
  JobRequestVersionPersistence,
  JobRequestLifecyclePersistence,
  JobInvitationPersistence,
  ConversationPersistence,
  ConversationChatPersistence,
  QuotePersistence,
  StructuredQuotePersistence,
} from "@portal/domain";
import * as schema from "./schema/index.js";

export {
  adminMfaChallenges,
  adminMfaFactorKindEnum,
  adminMfaFactors,
  adminMfaPurposeEnum,
  adminPrivilegedSessions,
  adminRoleChangeEvents,
  adminRoleEnum,
  adminRoleGrants,
} from "./schema/index.js";
export {
  auditActorKindEnum,
  auditEventCategoryEnum,
  auditEvents,
  auditSensitiveAccessPurposeEnum,
} from "./schema/index.js";
export type { AuditEventRecord, NewAuditEventRecord } from "./schema/index.js";
export {
  privacyConsentActionEnum,
  privacyConsentEvents,
  privacyConsentPurposes,
  privacyOptionalConsentPurposeEnum,
  privacyPolicyKindEnum,
  privacyPolicyVersions,
  privacyRequestCases,
  privacyRequestEvents,
  privacyRequestStateEnum,
  privacyRequestTypeEnum,
  privacyRetentionCategoryEnum,
  privacyRetentionLaunchStateEnum,
  privacyRetentionPolicyVersions,
  privacyReviewStateEnum,
} from "./schema/index.js";
export type {
  PrivacyConsentEventRecord,
  PrivacyConsentPurposeRecord,
  PrivacyPolicyVersionRecord,
  PrivacyRequestCaseRecord,
  PrivacyRequestEventRecord,
  PrivacyRetentionPolicyVersionRecord,
} from "./schema/index.js";
export {
  FEATURED_PROJECT_COMMAND_KINDS,
  featuredProjectCommandKindEnum,
  featuredProjectCommands,
  featuredProjectRevisions,
  featuredProjectSets,
} from "./schema/index.js";
export type {
  FeaturedProjectCommandRecord,
  FeaturedProjectRevisionRecord,
  FeaturedProjectSetRecord,
} from "./schema/index.js";
export {
  PORTFOLIO_PHOTO_COMMAND_KINDS,
  portfolioPhotoAttachments,
  portfolioPhotoCommandKindEnum,
  portfolioPhotoCommands,
  portfolioPhotoPhaseEnum,
  portfolioPhotoRevisionItems,
  portfolioPhotoRevisions,
  portfolioPhotoStateEnum,
  portfolioProjectPhotoSets,
} from "./schema/index.js";
export type {
  PortfolioPhotoAttachmentRecord,
  PortfolioPhotoCommandRecord,
  PortfolioPhotoRevisionItemRecord,
  PortfolioPhotoRevisionRecord,
  PortfolioProjectPhotoSetRecord,
} from "./schema/index.js";
export {
  PORTFOLIO_PROJECT_PUBLICATION_COMMAND_KINDS,
  PORTFOLIO_PROJECT_PUBLICATION_STATES,
  portfolioProjectPublicationCommandKindEnum,
  portfolioProjectPublicationCommands,
  portfolioProjectPublicationItems,
  portfolioProjectPublicationRevisions,
  portfolioProjectPublications,
  portfolioProjectPublicationStateEnum,
} from "./schema/index.js";
export type {
  PortfolioProjectPublicationCommandRecord,
  PortfolioProjectPublicationItemRecord,
  PortfolioProjectPublicationRecord,
  PortfolioProjectPublicationRevisionRecord,
} from "./schema/index.js";
export {
  PORTFOLIO_PROJECT_COMMAND_KINDS,
  portfolioProjectCommandKindEnum,
  portfolioProjectCommands,
  portfolioProjectDurationUnitEnum,
  portfolioProjectProvenanceKindEnum,
  portfolioProjectRecordStateEnum,
  portfolioProjectRevisions,
  portfolioProjects,
} from "./schema/index.js";
export type {
  PortfolioProjectCommandRecord,
  PortfolioProjectRecord,
  PortfolioProjectRevisionRecord,
} from "./schema/index.js";
export {
  portfolioCollaborationActorKindEnum,
  portfolioCollaborationCommandKindEnum,
  portfolioCollaborationCommands,
  portfolioCollaborationRevisions,
  portfolioCollaborations,
  portfolioCollaborationStateEnum,
  portfolioCollaborationVisibilityEnum,
  PORTFOLIO_COLLABORATION_ACTOR_KINDS,
  PORTFOLIO_COLLABORATION_COMMAND_KINDS,
} from "./schema/index.js";
export type {
  PortfolioCollaborationCommandRecord,
  PortfolioCollaborationRecord,
  PortfolioCollaborationRevisionRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_AVAILABILITY_COMMAND_KINDS,
  CRAFTSMAN_AVAILABILITY_COMMAND_RESULTS,
  craftsmanAvailabilityBlockStateEnum,
  craftsmanAvailabilityCommandKindEnum,
  craftsmanAvailabilityCommandResultEnum,
  craftsmanAvailabilityCommands,
  craftsmanAvailabilityRevisions,
  craftsmanAvailabilityStateEnum,
} from "./schema/index.js";
export type {
  CraftsmanAvailabilityCommandRecord,
  CraftsmanAvailabilityRevisionRecord,
} from "./schema/index.js";
export {
  craftsmanProfileModerationStateEnum,
  craftsmanProfileOwnerVisibilityEnum,
  craftsmanProfilePublicationActorKindEnum,
  craftsmanProfilePublicationCommandKindEnum,
  craftsmanProfilePublicationCommands,
  craftsmanProfilePublicationRevisions,
  craftsmanProfileReviewStateEnum,
  PROFILE_PUBLICATION_ACTOR_KINDS,
  PROFILE_PUBLICATION_COMMAND_KINDS,
} from "./schema/index.js";
export type {
  CraftsmanProfilePublicationCommandRecord,
  CraftsmanProfilePublicationRevisionRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_SKILL_COMMAND_KINDS,
  CRAFTSMAN_SPECIALIZATION_COMMAND_KINDS,
  craftsmanCapabilityStateEnum,
  craftsmanCustomSkillMappingEvents,
  craftsmanSkillCommands,
  craftsmanSkillCommandKindEnum,
  craftsmanSkillIdentityKindEnum,
  craftsmanSkillProfessionLinks,
  craftsmanSkills,
  craftsmanSpecializationCommands,
  craftsmanSpecializationCommandKindEnum,
  craftsmanSpecializations,
  skillCatalogActivationEvents,
  skillCatalogReleases,
  skillCatalogSkillProfessions,
  skillCatalogSkills,
} from "./schema/index.js";
export type {
  CraftsmanSkillRecord,
  CraftsmanSpecializationRecord,
  SkillCatalogReleaseRecord,
  SkillCatalogSkillRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_SERVICE_AREA_COMMAND_RESULTS,
  craftsmanServiceAreaCommandResultEnum,
  craftsmanServiceAreaCommands,
  craftsmanServiceAreaExtraMunicipalities,
  craftsmanServiceAreaRevisions,
  locationDistricts,
  locationMunicipalities,
  locationRegions,
} from "./schema/index.js";
export type {
  CraftsmanServiceAreaCommandRecord,
  CraftsmanServiceAreaRevisionRecord,
  LocationDistrictRecord,
  LocationMunicipalityRecord,
  LocationRegionRecord,
} from "./schema/index.js";
export {
  professionTaxonomyActivationEvents,
  professionTaxonomyReleases,
  taxonomyAliases,
  taxonomyAliasKindEnum,
  taxonomyAliasTargetKindEnum,
  taxonomyCapabilityCriteria,
  taxonomyCapabilityLevelEnum,
  taxonomyContentClassEnum,
  taxonomyEntryStateEnum,
  taxonomyProfessions,
  taxonomyReviewStateEnum,
  taxonomySpecializations,
} from "./schema/index.js";
export type {
  ProfessionTaxonomyReleaseRecord,
  TaxonomyProfessionRecord,
  TaxonomySpecializationRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_PROFESSION_COMMAND_KINDS,
  craftsmanProfessionCommandKindEnum,
  craftsmanProfessionCommands,
  craftsmanProfessionDeclaredLevelEvents,
  craftsmanProfessions,
  craftsmanProfessionStateEnum,
  professionProficiencyLevelEnum,
} from "./schema/index.js";
export type {
  CraftsmanProfessionCommandRecord,
  CraftsmanProfessionDeclaredLevelEventRecord,
  CraftsmanProfessionRecord,
} from "./schema/index.js";
export {
  INDICATIVE_PRICING_COMMAND_KINDS,
  indicativePriceModeEnum,
  indicativePricingCommandKindEnum,
  indicativePricingCommands,
  indicativePricingEntries,
  indicativePricingEntryRevisions,
  indicativePricingEntryStateEnum,
} from "./schema/index.js";
export type {
  IndicativePricingCommandRecord,
  IndicativePricingEntryRecord,
  IndicativePricingEntryRevisionRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_EXPERIENCE_COMMAND_RESULTS,
  craftsmanExperienceCommandResultEnum,
  craftsmanExperienceCommands,
  craftsmanExperienceRevisions,
} from "./schema/index.js";
export type {
  CraftsmanExperienceCommandRecord,
  CraftsmanExperienceRevisionRecord,
} from "./schema/index.js";
export {
  CREDENTIAL_CLAIM_COMMAND_KINDS,
  credentialClaimCommandKindEnum,
  credentialClaimCommands,
  credentialClaimDecisions,
  credentialClaimEvidence,
  credentialClaimRevisions,
  credentialClaims,
  credentialClaimStateEnum,
  credentialEvidenceRequirementEnum,
  credentialReviewReasonCategoryEnum,
  credentialTypePolicies,
} from "./schema/index.js";
export type {
  CredentialClaimCommandRecord,
  CredentialClaimDecisionRecord,
  CredentialClaimEvidenceRecord,
  CredentialClaimRecord,
  CredentialClaimRevisionRecord,
  CredentialTypePolicyRecord,
} from "./schema/index.js";
export type {
  AdminMfaChallengeRecord,
  AdminMfaFactorRecord,
  AdminPrivilegedSessionRecord,
  AdminRoleChangeEventRecord,
  AdminRoleGrantRecord,
} from "./schema/index.js";
export {
  authCredentials,
  authRateLimitBuckets,
  authSessions,
  emailVerificationTokens,
  passwordResetTokens,
  phoneVerificationChallenges,
  USER_ACCOUNT_STATE_VALUES,
  userAccountStateEnum,
  users,
} from "./schema/index.js";
export {
  MEDIA_ASSET_STATUS_VALUES,
  MEDIA_KIND_VALUES,
  MEDIA_PROVENANCE_ENTITY_TYPE_VALUES,
  MEDIA_STORAGE_AREA_VALUES,
  MEDIA_STORAGE_ROLE_VALUES,
  MEDIA_UPLOAD_PURPOSE_VALUES,
  mediaAssetStatusEnum,
  mediaAssetStorageObjects,
  mediaAssets,
  mediaKindEnum,
  mediaProvenanceEntityTypeEnum,
  mediaStorageAreaEnum,
  mediaStorageRoleEnum,
  mediaUploadPurposeEnum,
} from "./schema/index.js";
export type {
  AuthCredentialRecord,
  AuthRateLimitBucketRecord,
  AuthSessionJsonValue,
  AuthSessionPayload,
  AuthSessionRecord,
  EmailVerificationTokenRecord,
  NewAuthCredentialRecord,
  NewEmailVerificationTokenRecord,
  NewAuthSessionRecord,
  NewPasswordResetTokenRecord,
  NewPhoneVerificationChallengeRecord,
  NewUserRecord,
  PasswordResetTokenRecord,
  PhoneVerificationChallengeRecord,
  UserRecord,
} from "./schema/index.js";
export { customerProfiles } from "./schema/index.js";
export type {
  CustomerProfileRecord,
  NewCustomerProfileRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_PROFILE_TYPE_VALUES,
  craftsmanProfiles,
  craftsmanProfileTypeEnum,
} from "./schema/index.js";
export type {
  CraftsmanProfileRecord,
  NewCraftsmanProfileRecord,
} from "./schema/index.js";
export type {
  MediaAssetRecord,
  MediaAssetStorageObjectRecord,
  NewMediaAssetRecord,
  NewMediaAssetStorageObjectRecord,
} from "./schema/index.js";
export {
  domainOutboxEvents,
  OUTBOX_EVENT_STATUS_VALUES,
  outboxConsumerEffects,
  outboxEventStatusEnum,
} from "./schema/index.js";
export type {
  DomainOutboxEventRecord,
  NewDomainOutboxEventRecord,
  OutboxConsumerEffectRecord,
} from "./schema/index.js";
export {
  NOTIFICATION_CHANNEL_VALUES,
  NOTIFICATION_DELIVERY_STATE_VALUES,
  NOTIFICATION_PRIORITY_VALUES,
  notificationChannelEnum,
  notificationDeliveries,
  notificationDeliveryStateEnum,
  notificationPriorityEnum,
  notifications,
} from "./schema/index.js";
export type {
  NewNotificationDeliveryRecord,
  NewNotificationRecord,
  NotificationDeliveryRecord,
  NotificationRecord,
} from "./schema/index.js";

export { createAuthRepository } from "./auth-repository.js";
export { createAdminAccessRepository } from "./admin-auth-repository.js";
export type { AdminAccessRepository } from "@portal/admin-auth";
export { createAuditRepository } from "./audit-repository.js";
export type { AuditRepository } from "@portal/audit";
export {
  createCraftsmanPublicationRepository,
  CraftsmanPublicationIdempotencyError,
} from "./craftsman-publication-repository.js";
export type { CraftsmanPublicationPersistence } from "@portal/domain";
export { createPublicCraftsmanProfileRepository } from "./public-craftsman-profile-repository.js";
export type { PublicCraftsmanProfilePersistence } from "@portal/domain";
export { createCraftsmanSearchReadModelRepository } from "./craftsman-search-read-model-repository.js";
export { createCraftsmanDistanceRepository } from "./craftsman-distance-repository.js";
export { createCraftsmanServiceAreaMatchRepository } from "./craftsman-service-area-match-repository.js";
export { createCraftsmanAvailabilityMatchRepository } from "./craftsman-availability-match-repository.js";
export { createCraftsmanTrustEvidenceRepository } from "./craftsman-trust-evidence-repository.js";
export { createPublicSearchCardSource } from "./public-search-card-source.js";
export type {
  DatabasePublicSearchCardQuery,
  DatabasePublicSearchCardSource,
  DatabasePublicSearchPreparedCohort,
} from "./public-search-card-source.js";
export type {
  CraftsmanAvailabilityMatchPersistence,
  CraftsmanDistancePersistence,
  CraftsmanSearchReadModelPersistence,
  CraftsmanServiceAreaMatchPersistence,
  CraftsmanTrustEvidencePersistence,
} from "@portal/domain";
export { createTaxonomyAutocompleteRepository } from "./taxonomy-autocomplete-repository.js";
export { createCredentialQualificationRepository } from "./credential-qualification-repository.js";
export type {
  CredentialQualificationPolicyPersistence,
  TaxonomyAutocompletePersistence,
} from "@portal/search";
export {
  CRAFTSMAN_AVAILABILITY_MATCH_FUNCTION,
  CRAFTSMAN_AVAILABILITY_MATCH_RESULT_COLUMNS,
  CRAFTSMAN_SEARCH_READ_MODEL_VIEWS,
  CRAFTSMAN_SERVICE_AREA_MATCH_FUNCTION,
  CRAFTSMAN_SERVICE_AREA_MATCH_RESULT_COLUMNS,
  SEARCHABLE_CRAFTSMAN_PROFILE_COLUMNS,
} from "./schema/index.js";
export { createPrivacyRepository } from "./privacy-repository.js";
export type { PrivacyRepository } from "@portal/privacy";
export type {
  AuthCredential,
  AuthRepository,
  AuthUser,
  ConsumePasswordResetResult,
  ConsumeRateLimitInput,
  CreatePasswordResetInput,
  PasswordResetRecord,
  PersistedAuthSession,
  RateLimitResult,
  RegisterAuthUserInput,
  RegisterAuthUserResult,
  SaveAuthSessionInput,
} from "./auth-repository.js";
export { createEmailVerificationRepository } from "./email-verification-repository.js";
export type {
  ConsumeEmailVerificationResult,
  EmailVerificationRepository,
  IssueEmailVerificationInput,
  IssueEmailVerificationResult,
} from "./email-verification-repository.js";
export { createPhoneVerificationRepository } from "./phone-verification-repository.js";
export type {
  IssuePhoneVerificationInput,
  IssuePhoneVerificationResult,
  PhoneVerificationDigestMaterial,
  PhoneVerificationRepository,
  VerifyPhoneOtpResult,
} from "./phone-verification-repository.js";
export { createMediaRepository } from "./media-repository.js";
export { createPrivateMediaDeliveryRepository } from "./media-delivery-repository.js";
export {
  createConversationAttachmentMediaAccessResolver,
  createConversationAttachmentUploadAuthorization,
} from "./conversation-attachment-repository.js";
export type { PrivateMediaDeliveryRepository } from "@portal/media";
export type {
  CreateProcessingMediaAssetInput,
  MediaRepository,
  MediaProcessingTransitionResult,
  ProcessingMediaAsset,
} from "./media-repository.js";
export { createOutboxRepository } from "./outbox-repository.js";
export type {
  OutboxBacklogSnapshot,
  OutboxDatabaseTransaction,
  OutboxRepository,
} from "./outbox-repository.js";
export { createNotificationRepository } from "./notification-repository.js";
export type {
  NotificationDeliverySnapshot,
  NotificationListOptions,
  NotificationRepository,
} from "./notification-repository.js";
export { createProfessionTaxonomyRepository } from "./taxonomy-repository.js";
export type { ProfessionTaxonomyPersistence } from "@portal/taxonomy";
export { createCustomerProfileRepository } from "./customer-profile-repository.js";
export type { CustomerProfilePersistence } from "@portal/domain";
export {
  createCustomerShortlistRepository,
  CustomerShortlistIdempotencyError,
} from "./customer-shortlist-repository.js";
export type {
  CustomerShortlistRepositoryAddInput,
  CustomerShortlistRepositoryCommandInput,
  CustomerShortlistRepositoryCommandResult,
  CustomerShortlistRepositoryListResult,
} from "./customer-shortlist-repository.js";
export type { CustomerShortlistPersistence } from "@portal/domain";
export { createJobRequestRepository } from "./job-request-repository.js";
export type { JobRequestPersistence } from "@portal/domain";
export { createJobRequestDraftRepository } from "./job-request-draft-repository.js";
export type { JobRequestDraftPersistence } from "@portal/domain";
export { createJobRequestVersionRepository } from "./job-request-version-repository.js";
export type { JobRequestVersionPersistence } from "@portal/domain";
export { createJobRequestLifecycleRepository } from "./job-request-lifecycle-repository.js";
export type { JobRequestLifecyclePersistence } from "@portal/domain";
export { createJobInvitationRepository } from "./job-invitation-repository.js";
export { createJobInvitationReminderRepository } from "./job-invitation-notification-repository.js";
export type { JobInvitationPersistence } from "@portal/domain";
export { createConversationRepository } from "./conversation-repository.js";
export type { ConversationPersistence } from "@portal/domain";
export { createConversationChatRepository } from "./conversation-chat-repository.js";
export type { ConversationChatPersistence } from "@portal/domain";
export { createQuoteRepository } from "./quote-repository.js";
export type { QuotePersistence } from "@portal/domain";
export { createStructuredQuoteRepository } from "./quote-structured-repository.js";
export type { StructuredQuotePersistence } from "@portal/domain";
export { createJobRequestMediaUploadAuthorization } from "./job-request-media-repository.js";
export type { JobRequestMediaUploadAuthorization } from "@portal/media";
export { createCraftsmanProfileRepository } from "./craftsman-profile-repository.js";
export type { CraftsmanProfilePersistence } from "@portal/domain";
export {
  createCraftsmanProfessionRepository,
  CraftsmanProfessionIdempotencyError,
} from "./craftsman-profession-repository.js";
export type { CraftsmanProfessionPersistence } from "@portal/domain";
export {
  createIndicativePricingRepository,
  IndicativePricingIdempotencyError,
} from "./indicative-pricing-repository.js";
export type { IndicativePricingPersistence } from "@portal/domain";
export {
  createCraftsmanExperienceRepository,
  CraftsmanExperienceIdempotencyError,
} from "./craftsman-experience-repository.js";
export type { CraftsmanExperiencePersistence } from "@portal/domain";
export {
  createCraftsmanAvailabilityRepository,
  CraftsmanAvailabilityIdempotencyError,
} from "./craftsman-availability-repository.js";
export type { CraftsmanAvailabilityPersistence } from "@portal/domain";
export {
  createCredentialClaimRepository,
  createCredentialReviewService,
  CredentialClaimIdempotencyError,
} from "./credential-claim-repository.js";
export type {
  CredentialClaimRepository,
  CredentialReviewResult,
  CredentialReviewService,
  CredentialReviewServiceResult,
} from "./credential-claim-repository.js";
export type { CredentialClaimPersistence } from "@portal/domain";
export {
  createCraftsmanServiceAreaRepository,
  CraftsmanServiceAreaIdempotencyError,
} from "./craftsman-service-area-repository.js";
export type { CraftsmanServiceAreaPersistence } from "@portal/domain";
export {
  createCraftsmanCapabilityRepository,
  CraftsmanCapabilityIdempotencyError,
} from "./craftsman-capability-repository.js";
export type { CraftsmanCapabilityPersistence } from "@portal/domain";
export {
  createPortfolioProjectRepository,
  PortfolioProjectIdempotencyError,
} from "./portfolio-project-repository.js";
export type { PortfolioProjectPersistence } from "@portal/domain";
export {
  createPortfolioCollaborationRepository,
  PortfolioCollaborationIdempotencyError,
} from "./portfolio-collaboration-repository.js";
export type { PortfolioCollaborationPersistence } from "@portal/domain";
export {
  createPortfolioMediaEntityAccessResolver,
  createPortfolioProjectPhotoRepository,
  preparePortfolioPhotoUpload,
  PortfolioProjectPhotoIdempotencyError,
} from "./portfolio-project-media-repository.js";
export type { PreparePortfolioPhotoUploadResult } from "./portfolio-project-media-repository.js";
export type { PortfolioProjectPhotoPersistence } from "@portal/domain";
export {
  createPortfolioPublicationRepository,
  createPublicPortfolioDeliveryRepository,
  PortfolioPublicationIdempotencyError,
} from "./portfolio-publication-repository.js";
export type {
  PortfolioPublicationRepository,
  PublicPortfolioDeliveryRepository,
} from "@portal/media";
export {
  createFeaturedProjectRepository,
  FeaturedProjectIdempotencyError,
} from "./featured-project-repository.js";
export type { FeaturedProjectPersistence } from "@portal/domain";
export {
  createSkillCatalogRepository,
  prepareSkillCatalogRelease,
  SkillCatalogIdempotencyError,
} from "./skill-catalog-repository.js";
export type {
  PreparedSkillCatalogRelease,
  SkillCatalogReleaseSeed,
  SkillCatalogRepository,
  SkillCatalogSkillSeed,
} from "./skill-catalog-repository.js";

export {
  createPostgresMigrationStore,
  loadMigrations,
  migratePostgres,
  MigrationValidationError,
  nodeMigrationFileSystem,
  runMigrations,
} from "./migrator.js";
export {
  createMunicipalityAutocompleteRepository,
  type MunicipalityAutocompletePersistence,
  type MunicipalitySuggestion,
} from "./municipality-autocomplete-repository.js";
export type {
  AppliedMigration,
  Migration,
  MigrationFileSystem,
  MigrationRunResult,
  MigrationStore,
  PostgresMigrationStoreOptions,
} from "./migrator.js";

export interface DatabaseHealthProbe {
  ping(): Promise<void>;
}

export interface DatabaseClient extends DatabaseHealthProbe {
  /**
   * Typed query entry point. Domain schemas are intentionally added by later
   * migration tickets rather than by the foundation package.
   */
  readonly query: PostgresJsDatabase<typeof schema>;
  readonly auth: AuthRepository;
  readonly adminAccess: AdminAccessRepository;
  readonly audit: AuditRepository;
  readonly craftsmanProfiles: CraftsmanProfilePersistence;
  readonly craftsmanProfessions: CraftsmanProfessionPersistence;
  readonly craftsmanCapabilities: CraftsmanCapabilityPersistence;
  readonly craftsmanServiceAreas: CraftsmanServiceAreaPersistence;
  readonly indicativePricing: IndicativePricingPersistence;
  readonly portfolioProjects: PortfolioProjectPersistence;
  readonly portfolioCollaborations: PortfolioCollaborationPersistence;
  readonly portfolioProjectPhotos: PortfolioProjectPhotoPersistence;
  readonly portfolioPublication: PortfolioPublicationRepository;
  readonly publicPortfolioDelivery: PublicPortfolioDeliveryRepository;
  readonly featuredProjects: FeaturedProjectPersistence;
  readonly craftsmanExperience: CraftsmanExperiencePersistence;
  readonly craftsmanAvailability: CraftsmanAvailabilityPersistence;
  readonly craftsmanPublication: CraftsmanPublicationPersistence;
  readonly publicCraftsmanProfiles: PublicCraftsmanProfilePersistence;
  readonly craftsmanSearch: CraftsmanSearchReadModelPersistence;
  readonly craftsmanDistances: CraftsmanDistancePersistence;
  readonly craftsmanServiceAreaMatches: CraftsmanServiceAreaMatchPersistence;
  readonly craftsmanAvailabilityMatches: CraftsmanAvailabilityMatchPersistence;
  readonly craftsmanTrustEvidence: CraftsmanTrustEvidencePersistence;
  readonly publicSearchCards: ReturnType<typeof createPublicSearchCardSource>;
  readonly taxonomyAutocomplete: TaxonomyAutocompletePersistence;
  readonly municipalityAutocomplete: MunicipalityAutocompletePersistence;
  readonly credentialQualifications: CredentialQualificationPolicyPersistence;
  readonly credentialClaims: CredentialClaimRepository;
  readonly customerProfiles: CustomerProfilePersistence;
  readonly customerShortlist: CustomerShortlistPersistence;
  readonly jobRequests: JobRequestPersistence;
  readonly jobRequestDrafts: JobRequestDraftPersistence;
  readonly jobRequestVersions: JobRequestVersionPersistence;
  readonly jobRequestLifecycle: JobRequestLifecyclePersistence;
  readonly jobInvitations: JobInvitationPersistence;
  readonly jobInvitationReminders: JobInvitationReminderStore;
  readonly conversations: ConversationPersistence;
  readonly conversationChat: ConversationChatPersistence;
  readonly quotes: QuotePersistence;
  readonly structuredQuotes: StructuredQuotePersistence;
  readonly conversationAttachmentUploads: ConversationAttachmentUploadAuthorization;
  readonly conversationAttachmentMediaAccess: MediaEntityAccessResolver;
  readonly jobRequestMedia: JobRequestMediaUploadAuthorization;
  readonly emailVerification: EmailVerificationRepository;
  readonly media: MediaRepository;
  readonly privateMediaDelivery: PrivateMediaDeliveryRepository;
  readonly notifications: NotificationRepository;
  readonly outbox: OutboxRepository;
  readonly phoneVerification: PhoneVerificationRepository;
  readonly professionTaxonomy: ProfessionTaxonomyPersistence;
  readonly skillCatalog: SkillCatalogRepository;
  readonly privacy: PrivacyRepository;
  close(): Promise<void>;
}

export interface DatabaseConnectionOptions {
  readonly connectionString: string;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly maxConnections?: number;
}

export type HealthQueryExecutor = () => Promise<unknown>;

/** Creates an injectable probe without exposing connection details in results. */
export function createDatabaseHealthProbe(
  executeHealthQuery: HealthQueryExecutor,
): DatabaseHealthProbe {
  return Object.freeze({
    async ping(): Promise<void> {
      await executeHealthQuery();
    },
  });
}

/**
 * Opens a server-only PostgreSQL client. postgres-js parameterizes interpolated
 * values, while Drizzle is the public query layer for application code.
 */
export function createDatabase(
  options: DatabaseConnectionOptions,
): DatabaseClient {
  const sql = postgres(options.connectionString, {
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    max: options.maxConnections ?? 10,
    prepare: true,
  });
  const query = drizzle(sql, { schema });
  const auth = createAuthRepository(sql);
  const adminAccess = createAdminAccessRepository(sql);
  const audit = createAuditRepository(sql);
  const craftsmanProfiles = createCraftsmanProfileRepository(sql);
  const craftsmanProfessions = createCraftsmanProfessionRepository(sql);
  const craftsmanCapabilities = createCraftsmanCapabilityRepository(sql);
  const craftsmanServiceAreas = createCraftsmanServiceAreaRepository(sql);
  const indicativePricing = createIndicativePricingRepository(sql);
  const portfolioProjects = createPortfolioProjectRepository(sql);
  const portfolioCollaborations = createPortfolioCollaborationRepository(sql);
  const portfolioProjectPhotos = createPortfolioProjectPhotoRepository(sql);
  const portfolioPublication = createPortfolioPublicationRepository(sql);
  const publicPortfolioDelivery = createPublicPortfolioDeliveryRepository(sql);
  const featuredProjects = createFeaturedProjectRepository(sql);
  const craftsmanExperience = createCraftsmanExperienceRepository(sql);
  const craftsmanAvailability = createCraftsmanAvailabilityRepository(sql);
  const craftsmanPublication = createCraftsmanPublicationRepository(sql);
  const publicCraftsmanProfiles = createPublicCraftsmanProfileRepository(sql);
  const craftsmanSearch = createCraftsmanSearchReadModelRepository(sql);
  const craftsmanDistances = createCraftsmanDistanceRepository(sql);
  const craftsmanServiceAreaMatches =
    createCraftsmanServiceAreaMatchRepository(sql);
  const craftsmanAvailabilityMatches =
    createCraftsmanAvailabilityMatchRepository(sql);
  const craftsmanTrustEvidence = createCraftsmanTrustEvidenceRepository(sql);
  const publicSearchCards = createPublicSearchCardSource(sql);
  const taxonomyAutocomplete = createTaxonomyAutocompleteRepository(sql);
  const municipalityAutocomplete =
    createMunicipalityAutocompleteRepository(sql);
  const credentialQualifications = createCredentialQualificationRepository(sql);
  const credentialClaims = createCredentialClaimRepository(sql);
  const customerProfiles = createCustomerProfileRepository(sql);
  const customerShortlist = createCustomerShortlistRepository(sql);
  const jobRequests = createJobRequestRepository(sql);
  const jobRequestDrafts = createJobRequestDraftRepository(sql);
  const jobRequestVersions = createJobRequestVersionRepository(sql);
  const jobRequestLifecycle = createJobRequestLifecycleRepository(sql);
  const jobInvitations = createJobInvitationRepository(sql);
  const jobInvitationReminders = createJobInvitationReminderRepository(sql);
  const conversations = createConversationRepository(sql);
  const conversationChat = createConversationChatRepository(sql);
  const quotes = createQuoteRepository(sql);
  const structuredQuotes = createStructuredQuoteRepository(sql);
  const conversationAttachmentUploads =
    createConversationAttachmentUploadAuthorization(sql);
  const conversationAttachmentMediaAccess =
    createConversationAttachmentMediaAccessResolver(sql);
  const jobRequestMedia = createJobRequestMediaUploadAuthorization(sql);
  const emailVerification = createEmailVerificationRepository(sql);
  const media = createMediaRepository(sql);
  const privateMediaDelivery = createPrivateMediaDeliveryRepository(sql);
  const notifications = createNotificationRepository(sql);
  const outbox = createOutboxRepository(sql);
  const phoneVerification = createPhoneVerificationRepository(sql);
  const professionTaxonomy = createProfessionTaxonomyRepository(sql);
  const skillCatalog = createSkillCatalogRepository(sql);
  const privacy = createPrivacyRepository(sql);
  const health = createDatabaseHealthProbe(async () => {
    await sql`select 1 as health`;
  });

  return Object.freeze({
    adminAccess,
    audit,
    auth,
    craftsmanProfiles,
    craftsmanProfessions,
    craftsmanCapabilities,
    craftsmanServiceAreas,
    indicativePricing,
    portfolioProjects,
    portfolioCollaborations,
    portfolioProjectPhotos,
    portfolioPublication,
    publicPortfolioDelivery,
    featuredProjects,
    craftsmanExperience,
    craftsmanAvailability,
    craftsmanPublication,
    publicCraftsmanProfiles,
    craftsmanSearch,
    craftsmanDistances,
    craftsmanServiceAreaMatches,
    craftsmanAvailabilityMatches,
    craftsmanTrustEvidence,
    publicSearchCards,
    taxonomyAutocomplete,
    municipalityAutocomplete,
    credentialQualifications,
    credentialClaims,
    customerProfiles,
    customerShortlist,
    jobRequests,
    jobRequestDrafts,
    jobRequestVersions,
    jobRequestLifecycle,
    jobInvitations,
    jobInvitationReminders,
    conversations,
    conversationChat,
    quotes,
    structuredQuotes,
    conversationAttachmentUploads,
    conversationAttachmentMediaAccess,
    jobRequestMedia,
    emailVerification,
    media,
    privateMediaDelivery,
    notifications,
    outbox,
    phoneVerification,
    professionTaxonomy,
    skillCatalog,
    privacy,
    query,
    ping(): Promise<void> {
      return health.ping();
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  });
}
