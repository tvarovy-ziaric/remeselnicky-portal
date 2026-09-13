import type { UserAccountState, UserId } from "@portal/domain";

export const AUTH_API_PATHS = Object.freeze({
  csrf: "/v1/auth/csrf",
  login: "/v1/auth/login",
  logout: "/v1/auth/logout",
  passwordReset: "/v1/auth/password-reset",
  passwordResetRequest: "/v1/auth/password-reset-request",
  register: "/v1/auth/register",
  session: "/v1/auth/session",
} as const);

export const AUTH_INPUT_LIMITS = Object.freeze({
  emailMaximumLength: 254,
  passwordMaximumLength: 128,
  passwordMinimumLength: 12,
  resetTokenMaximumLength: 128,
} as const);

export interface AuthCsrfResponse {
  readonly csrfToken: string;
}

export interface AuthLoginRequest {
  readonly email: string;
  readonly password: string;
}

export interface AuthRegisterRequest extends AuthLoginRequest {
  readonly adultAttested: true;
}

export interface AuthPasswordResetRequest {
  readonly email: string;
}

export interface AuthPasswordResetConfirmRequest {
  readonly newPassword: string;
  readonly token: string;
}

export interface AuthUserResponse {
  readonly accountState: UserAccountState;
  readonly adultAttestedAt: string;
  readonly id: UserId;
}

export interface AuthSessionResponse {
  readonly csrfToken: string;
  readonly user: AuthUserResponse;
}

export interface AuthAcceptedResponse {
  readonly accepted: true;
}

export type AuthErrorCode =
  | "ACCOUNT_NOT_ACTIVE"
  | "AUTHENTICATION_REQUIRED"
  | "CSRF_INVALID"
  | "INTERNAL_ERROR"
  | "INVALID_CREDENTIALS"
  | "INVALID_OR_EXPIRED_RESET"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "REGISTRATION_NOT_AVAILABLE";

export interface AuthErrorResponse {
  readonly code: AuthErrorCode;
}
