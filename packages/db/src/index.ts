import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createAdminAccessRepository } from "./admin-auth-repository.js";
import type { AdminAccessRepository } from "@portal/admin-auth";
import { createAuditRepository } from "./audit-repository.js";
import type { AuditRepository } from "@portal/audit";
import {
  createAuthRepository,
  type AuthRepository,
} from "./auth-repository.js";
import {
  createEmailVerificationRepository,
  type EmailVerificationRepository,
} from "./email-verification-repository.js";
import {
  createMediaRepository,
  type MediaRepository,
} from "./media-repository.js";
import { createPrivateMediaDeliveryRepository } from "./media-delivery-repository.js";
import type { PrivateMediaDeliveryRepository } from "@portal/media";
import {
  createPhoneVerificationRepository,
  type PhoneVerificationRepository,
} from "./phone-verification-repository.js";
import {
  createOutboxRepository,
  type OutboxRepository,
} from "./outbox-repository.js";
import {
  createNotificationRepository,
  type NotificationRepository,
} from "./notification-repository.js";
import { createProfessionTaxonomyRepository } from "./taxonomy-repository.js";
import type { ProfessionTaxonomyPersistence } from "@portal/taxonomy";
import { createCraftsmanProfessionRepository } from "./craftsman-profession-repository.js";
import type { CraftsmanProfessionPersistence } from "@portal/domain";
import { createCraftsmanServiceAreaRepository } from "./craftsman-service-area-repository.js";
import type { CraftsmanServiceAreaPersistence } from "@portal/domain";
import { createCraftsmanCapabilityRepository } from "./craftsman-capability-repository.js";
import type { CraftsmanCapabilityPersistence } from "@portal/domain";
import { createSkillCatalogRepository } from "./skill-catalog-repository.js";
import type { SkillCatalogRepository } from "./skill-catalog-repository.js";
import { createIndicativePricingRepository } from "./indicative-pricing-repository.js";
import type { IndicativePricingPersistence } from "@portal/domain";
import { createPrivacyRepository } from "./privacy-repository.js";
import type { PrivacyRepository } from "@portal/privacy";
import { createCustomerProfileRepository } from "./customer-profile-repository.js";
import { createCraftsmanProfileRepository } from "./craftsman-profile-repository.js";
import type {
  CraftsmanProfilePersistence,
  CustomerProfilePersistence,
} from "@portal/domain";
import * as schema from "./schema/index.js";

export {
  adminMfaChallenges,
  adminMfaFactorKindEnum,
  adminMfaFactors,
  adminMfaPurposeEnum,
  adminPrivilegedSessions,
  adminRoleChangeEvents,
  adminRoleEnum,
  adminRoleGrants,
} from "./schema/index.js";
export {
  auditActorKindEnum,
  auditEventCategoryEnum,
  auditEvents,
  auditSensitiveAccessPurposeEnum,
} from "./schema/index.js";
export type { AuditEventRecord, NewAuditEventRecord } from "./schema/index.js";
export {
  privacyConsentActionEnum,
  privacyConsentEvents,
  privacyConsentPurposes,
  privacyOptionalConsentPurposeEnum,
  privacyPolicyKindEnum,
  privacyPolicyVersions,
  privacyRequestCases,
  privacyRequestEvents,
  privacyRequestStateEnum,
  privacyRequestTypeEnum,
  privacyRetentionCategoryEnum,
  privacyRetentionLaunchStateEnum,
  privacyRetentionPolicyVersions,
  privacyReviewStateEnum,
} from "./schema/index.js";
export type {
  PrivacyConsentEventRecord,
  PrivacyConsentPurposeRecord,
  PrivacyPolicyVersionRecord,
  PrivacyRequestCaseRecord,
  PrivacyRequestEventRecord,
  PrivacyRetentionPolicyVersionRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_SKILL_COMMAND_KINDS,
  CRAFTSMAN_SPECIALIZATION_COMMAND_KINDS,
  craftsmanCapabilityStateEnum,
  craftsmanCustomSkillMappingEvents,
  craftsmanSkillCommands,
  craftsmanSkillCommandKindEnum,
  craftsmanSkillIdentityKindEnum,
  craftsmanSkillProfessionLinks,
  craftsmanSkills,
  craftsmanSpecializationCommands,
  craftsmanSpecializationCommandKindEnum,
  craftsmanSpecializations,
  skillCatalogActivationEvents,
  skillCatalogReleases,
  skillCatalogSkillProfessions,
  skillCatalogSkills,
} from "./schema/index.js";
export type {
  CraftsmanSkillRecord,
  CraftsmanSpecializationRecord,
  SkillCatalogReleaseRecord,
  SkillCatalogSkillRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_SERVICE_AREA_COMMAND_RESULTS,
  craftsmanServiceAreaCommandResultEnum,
  craftsmanServiceAreaCommands,
  craftsmanServiceAreaExtraMunicipalities,
  craftsmanServiceAreaRevisions,
  locationDistricts,
  locationMunicipalities,
  locationRegions,
} from "./schema/index.js";
export type {
  CraftsmanServiceAreaCommandRecord,
  CraftsmanServiceAreaRevisionRecord,
  LocationDistrictRecord,
  LocationMunicipalityRecord,
  LocationRegionRecord,
} from "./schema/index.js";
export {
  professionTaxonomyActivationEvents,
  professionTaxonomyReleases,
  taxonomyAliases,
  taxonomyAliasKindEnum,
  taxonomyAliasTargetKindEnum,
  taxonomyCapabilityCriteria,
  taxonomyCapabilityLevelEnum,
  taxonomyContentClassEnum,
  taxonomyEntryStateEnum,
  taxonomyProfessions,
  taxonomyReviewStateEnum,
  taxonomySpecializations,
} from "./schema/index.js";
export type {
  ProfessionTaxonomyReleaseRecord,
  TaxonomyProfessionRecord,
  TaxonomySpecializationRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_PROFESSION_COMMAND_KINDS,
  craftsmanProfessionCommandKindEnum,
  craftsmanProfessionCommands,
  craftsmanProfessionDeclaredLevelEvents,
  craftsmanProfessions,
  craftsmanProfessionStateEnum,
  professionProficiencyLevelEnum,
} from "./schema/index.js";
export type {
  CraftsmanProfessionCommandRecord,
  CraftsmanProfessionDeclaredLevelEventRecord,
  CraftsmanProfessionRecord,
} from "./schema/index.js";
export {
  INDICATIVE_PRICING_COMMAND_KINDS,
  indicativePriceModeEnum,
  indicativePricingCommandKindEnum,
  indicativePricingCommands,
  indicativePricingEntries,
  indicativePricingEntryRevisions,
  indicativePricingEntryStateEnum,
} from "./schema/index.js";
export type {
  IndicativePricingCommandRecord,
  IndicativePricingEntryRecord,
  IndicativePricingEntryRevisionRecord,
} from "./schema/index.js";
export type {
  AdminMfaChallengeRecord,
  AdminMfaFactorRecord,
  AdminPrivilegedSessionRecord,
  AdminRoleChangeEventRecord,
  AdminRoleGrantRecord,
} from "./schema/index.js";
export {
  authCredentials,
  authRateLimitBuckets,
  authSessions,
  emailVerificationTokens,
  passwordResetTokens,
  phoneVerificationChallenges,
  USER_ACCOUNT_STATE_VALUES,
  userAccountStateEnum,
  users,
} from "./schema/index.js";
export {
  MEDIA_ASSET_STATUS_VALUES,
  MEDIA_KIND_VALUES,
  MEDIA_PROVENANCE_ENTITY_TYPE_VALUES,
  MEDIA_STORAGE_AREA_VALUES,
  MEDIA_STORAGE_ROLE_VALUES,
  MEDIA_UPLOAD_PURPOSE_VALUES,
  mediaAssetStatusEnum,
  mediaAssetStorageObjects,
  mediaAssets,
  mediaKindEnum,
  mediaProvenanceEntityTypeEnum,
  mediaStorageAreaEnum,
  mediaStorageRoleEnum,
  mediaUploadPurposeEnum,
} from "./schema/index.js";
export type {
  AuthCredentialRecord,
  AuthRateLimitBucketRecord,
  AuthSessionJsonValue,
  AuthSessionPayload,
  AuthSessionRecord,
  EmailVerificationTokenRecord,
  NewAuthCredentialRecord,
  NewEmailVerificationTokenRecord,
  NewAuthSessionRecord,
  NewPasswordResetTokenRecord,
  NewPhoneVerificationChallengeRecord,
  NewUserRecord,
  PasswordResetTokenRecord,
  PhoneVerificationChallengeRecord,
  UserRecord,
} from "./schema/index.js";
export { customerProfiles } from "./schema/index.js";
export type {
  CustomerProfileRecord,
  NewCustomerProfileRecord,
} from "./schema/index.js";
export {
  CRAFTSMAN_PROFILE_TYPE_VALUES,
  craftsmanProfiles,
  craftsmanProfileTypeEnum,
} from "./schema/index.js";
export type {
  CraftsmanProfileRecord,
  NewCraftsmanProfileRecord,
} from "./schema/index.js";
export type {
  MediaAssetRecord,
  MediaAssetStorageObjectRecord,
  NewMediaAssetRecord,
  NewMediaAssetStorageObjectRecord,
} from "./schema/index.js";
export {
  domainOutboxEvents,
  OUTBOX_EVENT_STATUS_VALUES,
  outboxConsumerEffects,
  outboxEventStatusEnum,
} from "./schema/index.js";
export type {
  DomainOutboxEventRecord,
  NewDomainOutboxEventRecord,
  OutboxConsumerEffectRecord,
} from "./schema/index.js";
export {
  NOTIFICATION_CHANNEL_VALUES,
  NOTIFICATION_DELIVERY_STATE_VALUES,
  NOTIFICATION_PRIORITY_VALUES,
  notificationChannelEnum,
  notificationDeliveries,
  notificationDeliveryStateEnum,
  notificationPriorityEnum,
  notifications,
} from "./schema/index.js";
export type {
  NewNotificationDeliveryRecord,
  NewNotificationRecord,
  NotificationDeliveryRecord,
  NotificationRecord,
} from "./schema/index.js";

export { createAuthRepository } from "./auth-repository.js";
export { createAdminAccessRepository } from "./admin-auth-repository.js";
export type { AdminAccessRepository } from "@portal/admin-auth";
export { createAuditRepository } from "./audit-repository.js";
export type { AuditRepository } from "@portal/audit";
export { createPrivacyRepository } from "./privacy-repository.js";
export type { PrivacyRepository } from "@portal/privacy";
export type {
  AuthCredential,
  AuthRepository,
  AuthUser,
  ConsumePasswordResetResult,
  ConsumeRateLimitInput,
  CreatePasswordResetInput,
  PasswordResetRecord,
  PersistedAuthSession,
  RateLimitResult,
  RegisterAuthUserInput,
  RegisterAuthUserResult,
  SaveAuthSessionInput,
} from "./auth-repository.js";
export { createEmailVerificationRepository } from "./email-verification-repository.js";
export type {
  ConsumeEmailVerificationResult,
  EmailVerificationRepository,
  IssueEmailVerificationInput,
  IssueEmailVerificationResult,
} from "./email-verification-repository.js";
export { createPhoneVerificationRepository } from "./phone-verification-repository.js";
export type {
  IssuePhoneVerificationInput,
  IssuePhoneVerificationResult,
  PhoneVerificationDigestMaterial,
  PhoneVerificationRepository,
  VerifyPhoneOtpResult,
} from "./phone-verification-repository.js";
export { createMediaRepository } from "./media-repository.js";
export { createPrivateMediaDeliveryRepository } from "./media-delivery-repository.js";
export type { PrivateMediaDeliveryRepository } from "@portal/media";
export type {
  CreateProcessingMediaAssetInput,
  MediaRepository,
  MediaProcessingTransitionResult,
  ProcessingMediaAsset,
} from "./media-repository.js";
export { createOutboxRepository } from "./outbox-repository.js";
export type {
  OutboxBacklogSnapshot,
  OutboxDatabaseTransaction,
  OutboxRepository,
} from "./outbox-repository.js";
export { createNotificationRepository } from "./notification-repository.js";
export type {
  NotificationDeliverySnapshot,
  NotificationListOptions,
  NotificationRepository,
} from "./notification-repository.js";
export { createProfessionTaxonomyRepository } from "./taxonomy-repository.js";
export type { ProfessionTaxonomyPersistence } from "@portal/taxonomy";
export { createCustomerProfileRepository } from "./customer-profile-repository.js";
export type { CustomerProfilePersistence } from "@portal/domain";
export { createCraftsmanProfileRepository } from "./craftsman-profile-repository.js";
export type { CraftsmanProfilePersistence } from "@portal/domain";
export {
  createCraftsmanProfessionRepository,
  CraftsmanProfessionIdempotencyError,
} from "./craftsman-profession-repository.js";
export type { CraftsmanProfessionPersistence } from "@portal/domain";
export {
  createIndicativePricingRepository,
  IndicativePricingIdempotencyError,
} from "./indicative-pricing-repository.js";
export type { IndicativePricingPersistence } from "@portal/domain";
export {
  createCraftsmanServiceAreaRepository,
  CraftsmanServiceAreaIdempotencyError,
} from "./craftsman-service-area-repository.js";
export type { CraftsmanServiceAreaPersistence } from "@portal/domain";
export {
  createCraftsmanCapabilityRepository,
  CraftsmanCapabilityIdempotencyError,
} from "./craftsman-capability-repository.js";
export type { CraftsmanCapabilityPersistence } from "@portal/domain";
export {
  createSkillCatalogRepository,
  prepareSkillCatalogRelease,
  SkillCatalogIdempotencyError,
} from "./skill-catalog-repository.js";
export type {
  PreparedSkillCatalogRelease,
  SkillCatalogReleaseSeed,
  SkillCatalogRepository,
  SkillCatalogSkillSeed,
} from "./skill-catalog-repository.js";

export {
  createPostgresMigrationStore,
  loadMigrations,
  migratePostgres,
  MigrationValidationError,
  nodeMigrationFileSystem,
  runMigrations,
} from "./migrator.js";
export type {
  AppliedMigration,
  Migration,
  MigrationFileSystem,
  MigrationRunResult,
  MigrationStore,
  PostgresMigrationStoreOptions,
} from "./migrator.js";

export interface DatabaseHealthProbe {
  ping(): Promise<void>;
}

export interface DatabaseClient extends DatabaseHealthProbe {
  /**
   * Typed query entry point. Domain schemas are intentionally added by later
   * migration tickets rather than by the foundation package.
   */
  readonly query: PostgresJsDatabase<typeof schema>;
  readonly auth: AuthRepository;
  readonly adminAccess: AdminAccessRepository;
  readonly audit: AuditRepository;
  readonly craftsmanProfiles: CraftsmanProfilePersistence;
  readonly craftsmanProfessions: CraftsmanProfessionPersistence;
  readonly craftsmanCapabilities: CraftsmanCapabilityPersistence;
  readonly craftsmanServiceAreas: CraftsmanServiceAreaPersistence;
  readonly indicativePricing: IndicativePricingPersistence;
  readonly customerProfiles: CustomerProfilePersistence;
  readonly emailVerification: EmailVerificationRepository;
  readonly media: MediaRepository;
  readonly privateMediaDelivery: PrivateMediaDeliveryRepository;
  readonly notifications: NotificationRepository;
  readonly outbox: OutboxRepository;
  readonly phoneVerification: PhoneVerificationRepository;
  readonly professionTaxonomy: ProfessionTaxonomyPersistence;
  readonly skillCatalog: SkillCatalogRepository;
  readonly privacy: PrivacyRepository;
  close(): Promise<void>;
}

export interface DatabaseConnectionOptions {
  readonly connectionString: string;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly maxConnections?: number;
}

export type HealthQueryExecutor = () => Promise<unknown>;

/** Creates an injectable probe without exposing connection details in results. */
export function createDatabaseHealthProbe(
  executeHealthQuery: HealthQueryExecutor,
): DatabaseHealthProbe {
  return Object.freeze({
    async ping(): Promise<void> {
      await executeHealthQuery();
    },
  });
}

/**
 * Opens a server-only PostgreSQL client. postgres-js parameterizes interpolated
 * values, while Drizzle is the public query layer for application code.
 */
export function createDatabase(
  options: DatabaseConnectionOptions,
): DatabaseClient {
  const sql = postgres(options.connectionString, {
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    max: options.maxConnections ?? 10,
    prepare: true,
  });
  const query = drizzle(sql, { schema });
  const auth = createAuthRepository(sql);
  const adminAccess = createAdminAccessRepository(sql);
  const audit = createAuditRepository(sql);
  const craftsmanProfiles = createCraftsmanProfileRepository(sql);
  const craftsmanProfessions = createCraftsmanProfessionRepository(sql);
  const craftsmanCapabilities = createCraftsmanCapabilityRepository(sql);
  const craftsmanServiceAreas = createCraftsmanServiceAreaRepository(sql);
  const indicativePricing = createIndicativePricingRepository(sql);
  const customerProfiles = createCustomerProfileRepository(sql);
  const emailVerification = createEmailVerificationRepository(sql);
  const media = createMediaRepository(sql);
  const privateMediaDelivery = createPrivateMediaDeliveryRepository(sql);
  const notifications = createNotificationRepository(sql);
  const outbox = createOutboxRepository(sql);
  const phoneVerification = createPhoneVerificationRepository(sql);
  const professionTaxonomy = createProfessionTaxonomyRepository(sql);
  const skillCatalog = createSkillCatalogRepository(sql);
  const privacy = createPrivacyRepository(sql);
  const health = createDatabaseHealthProbe(async () => {
    await sql`select 1 as health`;
  });

  return Object.freeze({
    adminAccess,
    audit,
    auth,
    craftsmanProfiles,
    craftsmanProfessions,
    craftsmanCapabilities,
    craftsmanServiceAreas,
    indicativePricing,
    customerProfiles,
    emailVerification,
    media,
    privateMediaDelivery,
    notifications,
    outbox,
    phoneVerification,
    professionTaxonomy,
    skillCatalog,
    privacy,
    query,
    ping(): Promise<void> {
      return health.ping();
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  });
}
