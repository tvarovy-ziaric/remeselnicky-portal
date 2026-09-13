export { createArgon2PasswordHasher } from "./password.js";
export { createAuthPersistence } from "./db-adapter.js";
export { createPostgresRateLimitStoreConstructor } from "./rate-limit-store.js";
export { createResetTokenService } from "./reset-token.js";
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
export { createSessionGuard, type SessionGuardResult } from "./guard.js";
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
