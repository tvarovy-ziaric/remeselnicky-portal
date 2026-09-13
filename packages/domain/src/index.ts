/** Framework-independent identifier used at domain boundaries. */
export type EntityId = string;

/** Minimal runtime descriptor proving that consumers share the domain package. */
export const domainContract = Object.freeze({
  entityIdRepresentation: "opaque-string",
} as const);

export { isUserAccountState, USER_ACCOUNT_STATES } from "./user.js";
export type { User, UserAccountState, UserId } from "./user.js";
