import type { UserAccountState, UserId } from "@portal/domain";

export const AUTH_API_PATHS = Object.freeze({
  csrf: "/v1/auth/csrf",
  login: "/v1/auth/login",
  logout: "/v1/auth/logout",
  passwordReset: "/v1/auth/password-reset",
  passwordResetRequest: "/v1/auth/password-reset-request",
  emailVerification: "/v1/auth/email-verification",
  emailVerificationResend: "/v1/auth/email-verification/resend",
  phoneVerificationSend: "/v1/auth/phone-verification/send",
  phoneVerificationVerify: "/v1/auth/phone-verification/verify",
  register: "/v1/auth/register",
  session: "/v1/auth/session",
} as const);

export const ADMIN_AUTH_API_PATHS = Object.freeze({
  challenge: "/v1/admin/auth/mfa/challenge",
  session: "/v1/admin/auth/session",
  verify: "/v1/admin/auth/mfa/verify",
} as const);

export const AUTH_INPUT_LIMITS = Object.freeze({
  emailMaximumLength: 254,
  passwordMaximumLength: 128,
  passwordMinimumLength: 12,
  phoneMaximumLength: 32,
  phoneOtpLength: 6,
  resetTokenMaximumLength: 128,
  verificationTokenMaximumLength: 128,
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

export interface AuthEmailVerificationRequest {
  readonly token: string;
}

export interface AuthPhoneVerificationSendRequest {
  readonly phone: string;
}

export interface AuthPhoneVerificationSendResponse {
  readonly accepted: true;
  readonly challengeId: string;
}

export interface AuthPhoneVerificationVerifyRequest {
  readonly challengeId: string;
  readonly otp: string;
}

export interface AuthUserResponse {
  readonly accountState: UserAccountState;
  readonly adultAttestedAt: string;
  readonly emailVerified: boolean;
  readonly id: UserId;
  readonly phoneVerified: boolean;
}

export interface AuthSessionResponse {
  readonly csrfToken: string;
  readonly user: AuthUserResponse;
}

export interface AuthAcceptedResponse {
  readonly accepted: true;
}

export interface AdminMfaChallengeRequest {
  readonly purpose: "PRIVILEGED_SESSION" | "ROLE_CHANGE";
}

export interface AdminMfaChallengeResponse {
  readonly challengeToken: string;
  readonly factorKind: "TOTP" | "WEBAUTHN";
  readonly publicChallenge: string | null;
}

export interface AdminMfaVerifyRequest {
  readonly challengeToken: string;
  readonly response: string;
}

export interface AdminSessionResponse {
  readonly capabilities: readonly string[];
  readonly mfaAuthenticatedAt: string;
  readonly roles: readonly ("ADMIN" | "SUPER_ADMIN")[];
}

export type AuthErrorCode =
  | "ACCOUNT_NOT_ACTIVE"
  | "AUTHENTICATION_REQUIRED"
  | "CSRF_INVALID"
  | "INTERNAL_ERROR"
  | "INVALID_CREDENTIALS"
  | "INVALID_OR_EXPIRED_RESET"
  | "INVALID_OR_EXPIRED_VERIFICATION"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "REGISTRATION_NOT_AVAILABLE";

export interface AuthErrorResponse {
  readonly code: AuthErrorCode;
}
