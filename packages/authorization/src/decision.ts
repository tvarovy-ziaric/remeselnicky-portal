export const AUTHORIZATION_DENY_REASONS = Object.freeze([
  "ACTOR_REQUIRED",
  "ACTOR_UNTRUSTED",
  "ACCOUNT_NOT_ACTIVE",
  "CONTEXT_UNTRUSTED",
  "POLICY_DENIED",
  "POLICY_ERROR",
  "POLICY_INVALID_RESULT",
  "POLICY_NOT_REGISTERED",
  "PUBLIC_OPERATION_NOT_ALLOWLISTED",
  "TARGET_NOT_RESOLVED",
] as const);

export const AUTHORIZATION_PERMIT_REASONS = Object.freeze([
  "POLICY_PERMITTED",
  "PUBLIC_OPERATION_ALLOWLISTED",
] as const);

export type AuthorizationDenyReason =
  (typeof AUTHORIZATION_DENY_REASONS)[number];
export type AuthorizationPermitReason =
  (typeof AUTHORIZATION_PERMIT_REASONS)[number];

export type AuthorizationDecision =
  | {
      readonly effect: "DENY";
      readonly reason: AuthorizationDenyReason;
    }
  | {
      readonly effect: "PERMIT";
      readonly reason: AuthorizationPermitReason;
    };

const decisions: Readonly<
  Record<
    AuthorizationDenyReason | AuthorizationPermitReason,
    AuthorizationDecision
  >
> = Object.freeze({
  ACCOUNT_NOT_ACTIVE: Object.freeze({
    effect: "DENY",
    reason: "ACCOUNT_NOT_ACTIVE",
  }),
  ACTOR_REQUIRED: Object.freeze({
    effect: "DENY",
    reason: "ACTOR_REQUIRED",
  }),
  ACTOR_UNTRUSTED: Object.freeze({
    effect: "DENY",
    reason: "ACTOR_UNTRUSTED",
  }),
  CONTEXT_UNTRUSTED: Object.freeze({
    effect: "DENY",
    reason: "CONTEXT_UNTRUSTED",
  }),
  POLICY_DENIED: Object.freeze({
    effect: "DENY",
    reason: "POLICY_DENIED",
  }),
  POLICY_ERROR: Object.freeze({
    effect: "DENY",
    reason: "POLICY_ERROR",
  }),
  POLICY_INVALID_RESULT: Object.freeze({
    effect: "DENY",
    reason: "POLICY_INVALID_RESULT",
  }),
  POLICY_NOT_REGISTERED: Object.freeze({
    effect: "DENY",
    reason: "POLICY_NOT_REGISTERED",
  }),
  POLICY_PERMITTED: Object.freeze({
    effect: "PERMIT",
    reason: "POLICY_PERMITTED",
  }),
  PUBLIC_OPERATION_ALLOWLISTED: Object.freeze({
    effect: "PERMIT",
    reason: "PUBLIC_OPERATION_ALLOWLISTED",
  }),
  PUBLIC_OPERATION_NOT_ALLOWLISTED: Object.freeze({
    effect: "DENY",
    reason: "PUBLIC_OPERATION_NOT_ALLOWLISTED",
  }),
  TARGET_NOT_RESOLVED: Object.freeze({
    effect: "DENY",
    reason: "TARGET_NOT_RESOLVED",
  }),
});

export function authorizationDecision(
  reason: AuthorizationDenyReason | AuthorizationPermitReason,
): AuthorizationDecision {
  return decisions[reason];
}
