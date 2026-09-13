import type { EntityId } from "@portal/domain";

export { AUTH_API_PATHS, AUTH_INPUT_LIMITS } from "./auth.js";
export type {
  AuthAcceptedResponse,
  AuthCsrfResponse,
  AuthErrorCode,
  AuthErrorResponse,
  AuthLoginRequest,
  AuthPasswordResetConfirmRequest,
  AuthPasswordResetRequest,
  AuthRegisterRequest,
  AuthSessionResponse,
  AuthUserResponse,
} from "./auth.js";

/** Minimal transport-safe reference shared by API producers and consumers. */
export interface ApiResourceReference {
  readonly id: EntityId;
}

/** Runtime contract marker used to verify cross-workspace imports. */
export const platformContract = Object.freeze({
  apiVersion: "v1",
} as const);

export type PlatformContract = typeof platformContract;
