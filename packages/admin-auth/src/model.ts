import type { UserId } from "@portal/domain";

export const ADMIN_ROLE_VALUES = Object.freeze([
  "ADMIN",
  "SUPER_ADMIN",
] as const);
export type AdminRole = (typeof ADMIN_ROLE_VALUES)[number];

export const ADMIN_CAPABILITY_VALUES = Object.freeze([
  "admin.access",
  "admin.credentials.review",
  "admin.disputes.manage",
  "admin.jobs.correct",
  "admin.profiles.review",
  "admin.profiles.moderate",
  "admin.reviews.moderate",
  "admin.sensitive.read",
  "admin.users.manage",
  "admin.roles.manage",
] as const);
export type AdminCapability = (typeof ADMIN_CAPABILITY_VALUES)[number];

export const ADMIN_MFA_FACTOR_KIND_VALUES = Object.freeze([
  "TOTP",
  "WEBAUTHN",
] as const);
export type AdminMfaFactorKind = (typeof ADMIN_MFA_FACTOR_KIND_VALUES)[number];

export const ADMIN_MFA_PURPOSE_VALUES = Object.freeze([
  "PRIVILEGED_SESSION",
  "ROLE_CHANGE",
] as const);
export type AdminMfaPurpose = (typeof ADMIN_MFA_PURPOSE_VALUES)[number];

const adminCapabilities = Object.freeze<readonly AdminCapability[]>([
  "admin.access",
  "admin.credentials.review",
  "admin.disputes.manage",
  "admin.jobs.correct",
  "admin.profiles.review",
  "admin.profiles.moderate",
  "admin.reviews.moderate",
  "admin.users.manage",
]);
const superAdminCapabilities = ADMIN_CAPABILITY_VALUES;

export function capabilitiesForRoles(
  roles: readonly AdminRole[],
): ReadonlySet<AdminCapability> {
  const capabilities = new Set<AdminCapability>();
  for (const role of roles) {
    const additions =
      role === "SUPER_ADMIN" ? superAdminCapabilities : adminCapabilities;
    for (const capability of additions) capabilities.add(capability);
  }
  return capabilities;
}

export interface ActiveAdminFactor {
  readonly credentialReference: string;
  readonly factorId: string;
  readonly kind: AdminMfaFactorKind;
}

export interface PrivilegedIdentity {
  readonly factors: readonly ActiveAdminFactor[];
  readonly roles: readonly AdminRole[];
  readonly userId: UserId;
}

export interface PrivilegedSessionRecord {
  readonly expiresAt: Date;
  readonly factorId: string;
  readonly mfaAuthenticatedAt: Date;
  readonly roles: readonly AdminRole[];
  readonly userId: UserId;
}

export interface ClaimedMfaChallenge {
  readonly credentialReference: string;
  readonly factorId: string;
  readonly kind: AdminMfaFactorKind;
  readonly providerStateReference: string | null;
  readonly purpose: AdminMfaPurpose;
  readonly userId: UserId;
}

export interface AdminRoleChangeEvent {
  readonly action: "ADMIN_ROLE_GRANTED" | "ADMIN_ROLE_REVOKED";
  readonly actorUserId: UserId;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly reason: string;
  readonly role: AdminRole;
  readonly targetUserId: UserId;
}

export interface AdminAccessRepository {
  changeRole(input: {
    readonly action: "GRANT" | "REVOKE";
    readonly actorSessionIdDigest: string;
    readonly actorUserId: UserId;
    readonly eventId: string;
    readonly reason: string;
    readonly reauthenticationMaxAgeMs: number;
    readonly role: AdminRole;
    readonly targetUserId: UserId;
  }): Promise<AdminRoleChangeEvent | undefined>;
  claimMfaChallenge(input: {
    readonly challengeDigest: string;
    readonly now: Date;
    readonly userId: UserId;
  }): Promise<ClaimedMfaChallenge | undefined>;
  completeMfaChallenge(input: {
    readonly challengeDigest: string;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly sessionIdDigest: string;
    readonly userId: UserId;
  }): Promise<boolean>;
  createMfaChallenge(input: {
    readonly challengeDigest: string;
    readonly expiresAt: Date;
    readonly factorId: string;
    readonly providerStateReference: string | null;
    readonly purpose: AdminMfaPurpose;
    readonly userId: UserId;
  }): Promise<boolean>;
  findPrivilegedIdentity(
    userId: UserId,
  ): Promise<PrivilegedIdentity | undefined>;
  findPrivilegedSession(input: {
    readonly now: Date;
    readonly sessionIdDigest: string;
    readonly userId: UserId;
  }): Promise<PrivilegedSessionRecord | undefined>;
  revokePrivilegedSession(sessionIdDigest: string): Promise<void>;
}
