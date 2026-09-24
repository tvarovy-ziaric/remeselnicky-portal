export { createArgon2PasswordHasher } from "./password.js";
export { createAuthPersistence } from "./db-adapter.js";
export { createPostgresRateLimitStoreConstructor } from "./rate-limit-store.js";
export { createResetTokenService } from "./reset-token.js";
export {
  createEmailVerificationPersistence,
  createEmailVerificationService,
  createEmailVerificationTokenService,
  InvalidEmailVerificationTokenError,
  type EmailVerificationDeliveryPort,
  type EmailVerificationPersistence,
  type EmailVerificationService,
  type EmailVerificationTokenService,
} from "./email-verification.js";
export { registerAuthModule, type AuthModuleDependencies } from "./routes.js";
export {
  AuthInputError,
  createAuthService,
  InvalidResetTokenError,
  normalizeAndValidateEmail,
  validatePassword,
  type AuthService,
  type LoginResult,
  type RegistrationResult,
} from "./service.js";
export { createPostgresSessionStore } from "./session-store.js";
export {
  createPhoneOtpCrypto,
  createPhoneVerificationPersistence,
  createPhoneVerificationService,
  createSyntheticPhoneVerificationDelivery,
  InvalidPhoneVerificationInputError,
  normalizeAndValidatePhone,
  PhoneVerificationDeliveryUnavailableError,
  type PhoneOtpCrypto,
  type PhoneVerificationDeliveryPort,
  type PhoneVerificationPersistence,
  type PhoneVerificationService,
} from "./phone-verification.js";
export {
  createSessionGuard,
  type SessionAuthorizationScope,
  type SessionGuardResult,
} from "./guard.js";
export type {
  AuthCredential,
  AuthPersistence,
  AuthRuntimeConfig,
  AuthUser,
  PasswordHasher,
  PasswordResetDeliveryPort,
  RateLimitConsumption,
  RegistrationEligibilityPort,
  RegistrationPersistenceResult,
  ResetTokenService,
  StoredSession,
} from "./types.js";
