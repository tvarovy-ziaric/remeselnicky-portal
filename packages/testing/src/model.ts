export const SYNTHETIC_ACCOUNT_KINDS = Object.freeze([
  "CUSTOMER",
  "CRAFTSMAN_INDIVIDUAL",
  "CRAFTSMAN_COMPANY",
  "COMBINED",
  "ADMIN",
  "SUPERADMIN",
  "SUSPENDED",
] as const);

export type SyntheticAccountKind = (typeof SYNTHETIC_ACCOUNT_KINDS)[number];
export type SyntheticAccountState = "ACTIVE" | "SUSPENDED";
export type SyntheticAdminRole = "ADMIN" | "SUPER_ADMIN";
export type SyntheticCraftsmanProfileKind = "COMPANY" | "INDIVIDUAL";

export interface SyntheticProfileCapabilities {
  readonly customer: boolean;
  readonly craftsman: boolean;
  readonly craftsmanProfileKind: SyntheticCraftsmanProfileKind | null;
}

export interface SyntheticAnalyticsActor {
  readonly is_internal: boolean;
  readonly is_test: true;
  readonly kind: "ACTOR";
  readonly profile_context: "ADMIN" | "COMBINED" | "CRAFTSMAN" | "CUSTOMER";
  readonly user_id: string;
}

export interface SyntheticMfaFactorReference {
  /** Provider-owned opaque reference only. This is never a factor secret. */
  readonly credentialReference: string;
  readonly displayLabel: string;
  readonly kind: "WEBAUTHN";
}

export interface SyntheticAccountFixture {
  readonly accountKind: SyntheticAccountKind;
  readonly accountState: SyntheticAccountState;
  readonly adminRole: SyntheticAdminRole | null;
  readonly adultAttestedAt: Date;
  readonly analyticsActor: SyntheticAnalyticsActor;
  readonly createdAt: Date;
  readonly emailVerifiedAt: Date;
  readonly fixtureId: string;
  readonly locationCodes: readonly string[];
  readonly mfaFactor: SyntheticMfaFactorReference | null;
  readonly normalizedEmail: string;
  readonly normalizedPhone: string;
  readonly phoneVerifiedAt: Date;
  readonly professionCodes: readonly string[];
  readonly profileCapabilities: SyntheticProfileCapabilities;
  readonly synthetic: true;
  readonly userId: string;
}

export interface SlovakLocationSeed {
  readonly code: string;
  readonly countryCode: "SK";
  readonly displayName: string;
  readonly kind: "MUNICIPALITY" | "DISTRICT" | "REGION" | "SYNTHETIC_TEST_AREA";
  readonly parentCode: string | null;
  readonly synthetic: boolean;
}

export interface ProfessionTaxonomySeed {
  readonly code: string;
  readonly displayName: string;
  /** R1 must replace placeholders before they may become public taxonomy. */
  readonly placeholder: boolean;
  readonly synthetic: boolean;
}

export interface SyntheticSeedCatalog {
  readonly accounts: readonly SyntheticAccountFixture[];
  readonly locations: readonly SlovakLocationSeed[];
  readonly professions: readonly ProfessionTaxonomySeed[];
  readonly schemaVersion: 1;
  readonly synthetic: true;
}

export interface SeedCredentialHashProvider {
  readonly kind: "TEST_ONLY_HASH_PROVIDER";
  passwordHashFor(fixtureId: string): Promise<string>;
}

export interface PersistSyntheticAccountInput {
  readonly account: SyntheticAccountFixture;
  /** Already-hashed injected material. Plaintext credentials are never accepted. */
  readonly passwordHash: string;
}

export type SeedWriteResult = "CREATED" | "UNCHANGED";

export interface SyntheticSeedPersistence {
  readonly kind: "SYNTHETIC_SEED_PERSISTENCE";
  assertTargetEnvironment(
    environment: "development" | "staging" | "test",
  ): Promise<void>;
  upsertAccount(input: PersistSyntheticAccountInput): Promise<SeedWriteResult>;
}

export interface SyntheticSeedReport {
  readonly created: number;
  readonly environment: "development" | "staging" | "test";
  readonly unchanged: number;
}
