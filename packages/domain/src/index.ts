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
export type {
  CraftsmanServiceArea,
  CraftsmanServiceAreaPersistence,
  CraftsmanServiceAreaRevisionId,
  MunicipalityCode,
  ReplaceCraftsmanServiceAreaInput,
  ReplaceCraftsmanServiceAreaResult,
} from "./craftsman-service-area.js";
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
