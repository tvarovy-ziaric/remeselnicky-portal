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
