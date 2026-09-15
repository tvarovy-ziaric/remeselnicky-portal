/** Framework-independent identifier used at domain boundaries. */
export type EntityId = string;

/** Minimal runtime descriptor proving that consumers share the domain package. */
export const domainContract = Object.freeze({
  entityIdRepresentation: "opaque-string",
} as const);

export { isUserAccountState, USER_ACCOUNT_STATES } from "./user.js";
export type { User, UserAccountState, UserId } from "./user.js";
export {
  createCustomerProfileService,
  CustomerProfileUnavailableError,
} from "./customer-profile.js";
export type {
  CustomerProfile,
  CustomerProfileId,
  CustomerProfilePersistence,
  CustomerProfileService,
  EnsureCustomerProfilePersistenceResult,
  EnsureCustomerProfileResult,
} from "./customer-profile.js";
export {
  assertCustomerShortlistCommandInput,
  createCustomerShortlistService,
} from "./customer-shortlist.js";
export type {
  CustomerShortlistCommandInput,
  CustomerShortlistCommandResult,
  CustomerShortlistCommandStatus,
  CustomerShortlistEntry,
  CustomerShortlistListResult,
  CustomerShortlistPersistence,
  CustomerShortlistService,
  CustomerShortlistState,
  PersistCustomerShortlistCommandInput,
} from "./customer-shortlist.js";
export {
  CRAFTSMAN_PROFILE_TYPES,
  CraftsmanProfileValidationError,
  createCraftsmanProfileService,
  isCraftsmanProfileType,
} from "./craftsman-profile.js";
export type {
  CompanyCraftsmanProfile,
  CraftsmanProfile,
  CraftsmanProfileId,
  CraftsmanProfilePersistence,
  CraftsmanProfileService,
  CraftsmanProfileType,
  CreateCraftsmanProfileDraftInput,
  CreateCraftsmanProfileDraftResult,
  IndividualCraftsmanProfile,
  ReplaceCraftsmanProfileDraftInput,
  ReplaceCraftsmanProfileDraftResult,
  VerificationFact,
} from "./craftsman-profile.js";
export {
  assertAssignCraftsmanProfessionInput,
  assertChangeDeclaredProficiencyInput,
  assertCraftsmanProfessionListInput,
  assertDeactivateCraftsmanProfessionInput,
  CRAFTSMAN_PROFESSION_STATES,
  CraftsmanProfessionValidationError,
  PROFESSION_PROFICIENCY_LEVELS,
} from "./craftsman-profession.js";
export {
  ALPHA_EXTRA_SERVICE_AREA_UI_LIMIT,
  assertCraftsmanServiceAreaReadInput,
  assertReplaceCraftsmanServiceAreaInput,
  CraftsmanServiceAreaValidationError,
  normalizeTravelFeePolicy,
  SERVICE_AREA_EXTRA_TECHNICAL_LIMIT,
} from "./craftsman-service-area.js";
export {
  assertCraftsmanDistanceQueryInput,
  CRAFTSMAN_DISTANCE_QUERY_MAX_RESULTS,
  createCraftsmanDistanceFact,
  CraftsmanDistanceValidationError,
  MAX_RANKING_DISTANCE_METERS,
  serializePublicCraftsmanApproximateDistance,
} from "./craftsman-distance.js";
export type {
  CraftsmanDistanceFact,
  CraftsmanDistanceFactValues,
  CraftsmanDistancePersistence,
  CraftsmanDistanceQueryInput,
  CraftsmanDistanceQueryResult,
  PublicCraftsmanApproximateDistance,
} from "./craftsman-distance.js";
export type {
  CraftsmanServiceArea,
  CraftsmanServiceAreaPersistence,
  CraftsmanServiceAreaRevisionId,
  MunicipalityCode,
  ReplaceCraftsmanServiceAreaInput,
  ReplaceCraftsmanServiceAreaResult,
} from "./craftsman-service-area.js";
export {
  assertCraftsmanServiceAreaMatchQuery,
  CRAFTSMAN_SERVICE_AREA_MATCH_KINDS,
  createCraftsmanServiceAreaMatch,
  CraftsmanServiceAreaMatchValidationError,
  serializePublicCraftsmanServiceAreaMatch,
} from "./craftsman-service-area-match.js";
export type {
  CraftsmanServiceAreaMatch,
  CraftsmanServiceAreaMatchKind,
  CraftsmanServiceAreaMatchPersistence,
  CraftsmanServiceAreaMatchQuery,
  CraftsmanServiceAreaMatchResult,
  CraftsmanServiceAreaMatchValues,
  PublicCraftsmanServiceAreaMatch,
} from "./craftsman-service-area-match.js";
export type {
  AssignCraftsmanProfessionInput,
  AssignCraftsmanProfessionResult,
  ChangeDeclaredProficiencyInput,
  ChangeDeclaredProficiencyResult,
  CraftsmanProfession,
  CraftsmanProfessionId,
  CraftsmanProfessionPersistence,
  CraftsmanProfessionState,
  DeactivateCraftsmanProfessionInput,
  DeactivateCraftsmanProfessionResult,
  ProfessionProficiencyLevel,
} from "./craftsman-profession.js";
export {
  assertAddCraftsmanSkillInput,
  assertAddCraftsmanSpecializationInput,
  assertCraftsmanCapabilityListInput,
  assertDeactivateCraftsmanCapabilityInput,
  assertMapCustomCraftsmanSkillInput,
  CRAFTSMAN_CAPABILITY_STATES,
  CraftsmanCapabilityValidationError,
  isCraftsmanCapabilityPublicTextSafe,
  SKILL_IDENTITY_KINDS,
} from "./craftsman-capability.js";
export type {
  AddCanonicalCraftsmanSkillInput,
  AddCraftsmanSkillInput,
  AddCraftsmanSkillResult,
  AddCraftsmanSpecializationInput,
  AddCraftsmanSpecializationResult,
  AddCustomCraftsmanSkillInput,
  CapabilityEvidencePresentation,
  CraftsmanCapabilityPersistence,
  CraftsmanCapabilityState,
  CraftsmanSkill,
  CraftsmanSkillId,
  CraftsmanSpecialization,
  CraftsmanSpecializationId,
  DeactivateCraftsmanCapabilityInput,
  DeactivateCraftsmanSkillResult,
  DeactivateCraftsmanSpecializationResult,
  MapCustomCraftsmanSkillInput,
  MapCustomCraftsmanSkillResult,
  SkillIdentityKind,
} from "./craftsman-capability.js";
export {
  assertArchiveIndicativePricingEntryInput,
  assertIndicativePricingListInput,
  assertNormalizedAddIndicativePricingEntryInput,
  assertNormalizedEditIndicativePricingEntryInput,
  createIndicativePricingService,
  INDICATIVE_PRICE_MODES,
  INDICATIVE_PRICING_ENTRY_STATES,
  IndicativePricingValidationError,
} from "./indicative-pricing.js";
export {
  assertChangePortfolioProjectStateInput,
  assertCreatePortfolioProjectInput,
  assertEditPortfolioProjectInput,
  assertPortfolioProjectListInput,
  isPortfolioProjectPublicTextSafe,
  PORTFOLIO_DURATION_UNITS,
  PORTFOLIO_PROJECT_RECORD_STATES,
  PortfolioProjectValidationError,
} from "./portfolio-project.js";
export {
  assertAttachPortfolioProjectPhotoInput,
  assertHidePortfolioProjectPhotoInput,
  assertListPortfolioProjectPhotosInput,
  assertReorderPortfolioProjectPhotosInput,
  assertRestorePortfolioProjectPhotoInput,
  assertSetPortfolioProjectPhotoPhaseInput,
  PORTFOLIO_PHOTO_PHASES,
  PORTFOLIO_PHOTO_STATES,
  PORTFOLIO_PROJECT_MAX_PHOTOS,
  PortfolioProjectPhotoValidationError,
} from "./portfolio-project-media.js";
export {
  assertListOwnedFeaturedProjectsInput,
  assertPinFeaturedProjectInput,
  assertReorderFeaturedProjectsInput,
  assertUnpinFeaturedProjectInput,
  FEATURED_PROJECT_AVAILABILITY,
  FeaturedProjectValidationError,
  MAX_FEATURED_PROJECTS,
} from "./featured-projects.js";
export type {
  FeaturedProjectAvailability,
  FeaturedProjectCommandResult,
  FeaturedProjectItem,
  FeaturedProjectPersistence,
  FeaturedProjectSet,
  ListOwnedFeaturedProjectsInput,
  PinFeaturedProjectInput,
  ReorderFeaturedProjectsInput,
  UnpinFeaturedProjectInput,
} from "./featured-projects.js";
export type {
  AttachPortfolioProjectPhotoInput,
  HidePortfolioProjectPhotoInput,
  ListPortfolioProjectPhotosInput,
  PortfolioPhotoCommandResult,
  PortfolioPhotoPhase,
  PortfolioPhotoState,
  PortfolioProjectPhoto,
  PortfolioProjectPhotoAttachmentId,
  PortfolioProjectPhotoPersistence,
  PortfolioProjectPhotoSet,
  ReorderPortfolioProjectPhotosInput,
  RestorePortfolioProjectPhotoInput,
  SetPortfolioProjectPhotoPhaseInput,
} from "./portfolio-project-media.js";
export type {
  ChangePortfolioProjectStateInput,
  ChangePortfolioProjectStateResult,
  CreatePortfolioProjectInput,
  CreatePortfolioProjectResult,
  EditPortfolioProjectInput,
  EditPortfolioProjectResult,
  PortfolioDurationUnit,
  PortfolioProject,
  PortfolioProjectContent,
  PortfolioProjectId,
  PortfolioProjectPersistence,
  PortfolioProjectRecordState,
} from "./portfolio-project.js";
export {
  assertAddCraftsmanAvailabilityBlockInput,
  assertArchiveCraftsmanAvailabilityBlockInput,
  assertCraftsmanAvailabilityListInput,
  assertReplaceCraftsmanAvailabilityBlockInput,
  AVAILABILITY_EARLIEST_INSTANT_MS,
  AVAILABILITY_LATEST_INSTANT_MS,
  AVAILABILITY_MAX_BLOCK_DURATION_MS,
  CRAFTSMAN_AVAILABILITY_BLOCK_STATES,
  CRAFTSMAN_AVAILABILITY_STATES,
  CraftsmanAvailabilityValidationError,
} from "./craftsman-availability.js";
export type {
  AddCraftsmanAvailabilityBlockInput,
  AddCraftsmanAvailabilityBlockResult,
  ArchiveCraftsmanAvailabilityBlockInput,
  ArchiveCraftsmanAvailabilityBlockResult,
  CraftsmanAvailabilityBlock,
  CraftsmanAvailabilityBlockId,
  CraftsmanAvailabilityBlockState,
  CraftsmanAvailabilityPersistence,
  CraftsmanAvailabilityState,
  ReplaceCraftsmanAvailabilityBlockInput,
  ReplaceCraftsmanAvailabilityBlockResult,
} from "./craftsman-availability.js";
export {
  assertCraftsmanAvailabilityMatchQuery,
  CRAFTSMAN_AVAILABILITY_MATCH_KINDS,
  CRAFTSMAN_AVAILABILITY_MATCH_MAX_RESULTS,
  createCraftsmanAvailabilityMatch,
  CraftsmanAvailabilityMatchValidationError,
} from "./craftsman-availability-match.js";
export type {
  CraftsmanAvailabilityMatch,
  CraftsmanAvailabilityMatchKind,
  CraftsmanAvailabilityMatchPersistence,
  CraftsmanAvailabilityMatchQuery,
  CraftsmanAvailabilityMatchValues,
} from "./craftsman-availability-match.js";
export type {
  AddIndicativePricingEntryInput,
  AddIndicativePricingEntryResult,
  ArchiveIndicativePricingEntryInput,
  ArchiveIndicativePricingEntryResult,
  EditIndicativePricingEntryInput,
  EditIndicativePricingEntryResult,
  IndicativePriceMode,
  IndicativePricingEntry,
  IndicativePricingEntryId,
  IndicativePricingEntryState,
  IndicativePricingPersistence,
  IndicativePricingService,
} from "./indicative-pricing.js";
export {
  assertCraftsmanExperienceReadInput,
  assertReplaceCraftsmanExperienceInput,
  CraftsmanExperienceValidationError,
} from "./craftsman-experience.js";
export type {
  CraftsmanExperience,
  CraftsmanExperiencePersistence,
  CraftsmanExperienceRevisionId,
  ReplaceCraftsmanExperienceInput,
  ReplaceCraftsmanExperienceResult,
} from "./craftsman-experience.js";
export {
  assertAttachCredentialEvidenceInput,
  assertCreateCredentialClaimInput,
  assertCredentialClaimListInput,
  CREDENTIAL_CLAIM_STATES,
  CREDENTIAL_EVIDENCE_REQUIREMENTS,
  CREDENTIAL_REVIEW_REASON_CATEGORIES,
  CredentialClaimValidationError,
  isApprovedCredentialCurrentlyValid,
  normalizeCreateCredentialClaimInput,
  normalizeCredentialReviewCommand,
} from "./credential-claim.js";
export type {
  AttachCredentialEvidenceInput,
  AttachCredentialEvidenceResult,
  CreateCredentialClaimInput,
  CreateCredentialClaimResult,
  CredentialClaim,
  CredentialClaimId,
  CredentialClaimPersistence,
  CredentialClaimState,
  CredentialEvidenceReference,
  CredentialEvidenceRequirement,
  CredentialReviewCommand,
  CredentialReviewReasonCategory,
} from "./credential-claim.js";
export {
  assertOwnerProfilePublicationCommandInput,
  assertCraftsmanPublicationReadInput,
  assertPrivilegedProfileCommandInput,
  assertRejectCraftsmanProfileInput,
  assertRequireProfileIdentityReviewInput,
  assertRestoreProfileModerationInput,
  assertSetOwnerProfileVisibilityInput,
  assertSetProfileModerationInput,
  CraftsmanPublicationValidationError,
  PROFILE_IDENTITY_REVIEW_SYSTEM_REFERENCE,
  PROFILE_MODERATION_STATES,
  PROFILE_OWNER_VISIBILITY_STATES,
  PROFILE_READINESS_REQUIREMENTS,
  PROFILE_REVIEW_STATES,
} from "./craftsman-publication.js";
export {
  isPublicCraftsmanProfileId,
  isPublicDisplayTextSafe,
  PUBLIC_CRAFTSMAN_PROFILE_FIELDS,
  serializePublicCraftsmanProfile,
} from "./public-craftsman-profile.js";
export type {
  PublicCraftsmanProfile,
  PublicCraftsmanProfileCandidate,
  PublicCraftsmanProfilePersistence,
  PublicCraftsmanProfession,
  PublicCraftsmanSkill,
  PublicCraftsmanSpecialization,
  PublicIndicativePrice,
  PublicMunicipality,
  PublicPortfolioPhoto,
  PublicPortfolioProject,
  PublicVerifiedCredential,
} from "./public-craftsman-profile.js";
export type {
  CraftsmanPublicationPersistence,
  CraftsmanPublicationState,
  OwnerProfilePublicationCommandInput,
  PrivilegedProfileCommandInput,
  ProfileModerationFact,
  ProfileModerationState,
  ProfileOwnerVisibilityState,
  ProfilePublicationCommandResult,
  ProfileReadinessRequirement,
  ProfileRejectionFact,
  ProfileReviewDecisionFact,
  ProfileReviewState,
  RejectCraftsmanProfileInput,
  RequireProfileIdentityReviewInput,
  RestoreProfileModerationInput,
  SetOwnerProfileVisibilityInput,
  SetProfileModerationInput,
} from "./craftsman-publication.js";
export {
  assertAuthorPortfolioCollaborationStateInput,
  assertCollaboratorPortfolioCollaborationStateInput,
  assertEditPendingPortfolioCollaborationInput,
  assertInvitePortfolioCollaboratorInput,
  assertPortfolioCollaborationAuthorListInput,
  assertPortfolioCollaborationCollaboratorListInput,
  PORTFOLIO_COLLABORATION_STATES,
  PORTFOLIO_COLLABORATION_VISIBILITIES,
  PortfolioCollaborationValidationError,
} from "./portfolio-collaboration.js";
export type {
  AuthorPortfolioCollaborationStateInput,
  CollaboratorPortfolioCollaborationStateInput,
  EditPendingPortfolioCollaborationInput,
  InvitePortfolioCollaboratorInput,
  PortfolioCollaboration,
  PortfolioCollaborationCommandResult,
  PortfolioCollaborationId,
  PortfolioCollaborationPersistence,
  PortfolioCollaborationState,
  PortfolioCollaborationVisibility,
} from "./portfolio-collaboration.js";
export {
  CraftsmanSearchValidationError,
  normalizeSearchCraftsmanCandidatesInput,
  SEARCH_CANDIDATE_DEFAULT_LIMIT,
  SEARCH_CANDIDATE_MAX_LIMIT,
  SEARCH_IDENTITY_QUERY_MAX_LENGTH,
} from "./craftsman-search-read-model.js";
export type {
  CraftsmanSearchReadModelPersistence,
  NormalizedSearchCraftsmanCandidatesInput,
  SearchableCraftsmanCandidate,
  SearchableCraftsmanCandidatePage,
  SearchableCraftsmanCredential,
  SearchableCraftsmanProfession,
  SearchableCraftsmanPrice,
  SearchableCraftsmanSkill,
  SearchableCraftsmanSpecialization,
  SearchCraftsmanCandidatesInput,
} from "./craftsman-search-read-model.js";
export {
  CraftsmanTrustEvidenceValidationError,
  normalizeTrustEvidenceProfileIds,
  serializeCraftsmanTrustEvidence,
  TRUST_EVIDENCE_MAX_PROFILE_IDS,
} from "./craftsman-trust-evidence.js";
export type {
  CraftsmanTrustEvidenceCandidate,
  CraftsmanTrustEvidencePersistence,
  CraftsmanTrustEvidenceSummary,
  InsufficientEvidenceConfidence,
  ProfessionTrustEvidence,
  ProfessionTrustEvidenceCandidate,
  TrustEvidenceConfidence,
  TrustEvidenceConfidenceCandidate,
  TrustEvidenceQuality,
  TrustEvidenceQualityCandidate,
  TrustEvidenceVolume,
  TrustEvidenceVolumeCandidate,
} from "./craftsman-trust-evidence.js";
export * from "./job-request.js";
export * from "./job-request-draft.js";
export * from "./job-request-content.js";
export * from "./job-request-version.js";
export * from "./job-request-lifecycle.js";
export * from "./job-invitation.js";
