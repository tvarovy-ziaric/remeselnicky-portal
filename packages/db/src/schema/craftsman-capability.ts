import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  CRAFTSMAN_CAPABILITY_STATES,
  SKILL_IDENTITY_KINDS,
} from "@portal/domain";

import { craftsmanProfessions } from "./craftsman-profession.js";
import { craftsmanProfiles } from "./craftsman-profile.js";
import {
  professionTaxonomyReleases,
  taxonomyContentClassEnum,
  taxonomyEntryStateEnum,
  taxonomyProfessions,
  taxonomyReviewStateEnum,
  taxonomySpecializations,
} from "./taxonomy.js";
import { users } from "./user.js";

export const CRAFTSMAN_SPECIALIZATION_COMMAND_KINDS = Object.freeze([
  "ADD",
  "DEACTIVATE",
] as const);
export const CRAFTSMAN_SKILL_COMMAND_KINDS = Object.freeze([
  "ADD",
  "MAP_CUSTOM",
  "DEACTIVATE",
] as const);

export const craftsmanCapabilityStateEnum = pgEnum(
  "craftsman_capability_state",
  CRAFTSMAN_CAPABILITY_STATES,
);
export const craftsmanSkillIdentityKindEnum = pgEnum(
  "craftsman_skill_identity_kind",
  SKILL_IDENTITY_KINDS,
);
export const craftsmanSpecializationCommandKindEnum = pgEnum(
  "craftsman_specialization_command_kind",
  CRAFTSMAN_SPECIALIZATION_COMMAND_KINDS,
);
export const craftsmanSkillCommandKindEnum = pgEnum(
  "craftsman_skill_command_kind",
  CRAFTSMAN_SKILL_COMMAND_KINDS,
);

export const skillCatalogReleases = pgTable(
  "skill_catalog_releases",
  {
    releaseId: uuid("release_id").primaryKey(),
    version: integer("version").notNull(),
    professionTaxonomyReleaseId: uuid("profession_taxonomy_release_id")
      .notNull()
      .references(() => professionTaxonomyReleases.releaseId),
    contentClass: taxonomyContentClassEnum("content_class").notNull(),
    reviewState: taxonomyReviewStateEnum("review_state").notNull(),
    reviewReference: text("review_reference"),
    supersedesReleaseId: uuid("supersedes_release_id"),
    checksumSha256: char("checksum_sha256", { length: 64 }).notNull(),
    installationTxid: bigint("installation_txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    installedAt: timestamp("installed_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("skill_catalog_releases_version_key").on(table.version),
    unique("skill_catalog_releases_checksum_sha256_key").on(
      table.checksumSha256,
    ),
    unique("skill_catalog_releases_supersedes_release_id_key").on(
      table.supersedesReleaseId,
    ),
    unique("skill_catalog_release_profession_taxonomy_key").on(
      table.releaseId,
      table.professionTaxonomyReleaseId,
    ),
  ],
);

export const skillCatalogSkills = pgTable(
  "skill_catalog_skills",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => skillCatalogReleases.releaseId),
    skillCode: text("skill_code").notNull(),
    slug: text("slug").notNull(),
    labelSk: text("label_sk").notNull(),
    state: taxonomyEntryStateEnum("state").notNull(),
    replacedByCode: text("replaced_by_code"),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.skillCode] }),
    unique("skill_catalog_skills_release_slug_key").on(
      table.releaseId,
      table.slug,
    ),
  ],
);

export const skillCatalogSkillProfessions = pgTable(
  "skill_catalog_skill_professions",
  {
    releaseId: uuid("release_id").notNull(),
    skillCode: text("skill_code").notNull(),
    professionTaxonomyReleaseId: uuid(
      "profession_taxonomy_release_id",
    ).notNull(),
    professionCode: text("profession_code").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.releaseId, table.skillCode, table.professionCode],
    }),
    foreignKey({
      columns: [table.releaseId, table.skillCode],
      foreignColumns: [
        skillCatalogSkills.releaseId,
        skillCatalogSkills.skillCode,
      ],
      name: "skill_catalog_skill_professions_skill_fkey",
    }),
    foreignKey({
      columns: [table.professionTaxonomyReleaseId, table.professionCode],
      foreignColumns: [
        taxonomyProfessions.releaseId,
        taxonomyProfessions.professionCode,
      ],
      name: "skill_catalog_skill_professions_profession_fkey",
    }),
  ],
);

export const skillCatalogActivationEvents = pgTable(
  "skill_catalog_activation_events",
  {
    activationId: uuid("activation_id").primaryKey(),
    activationSequence: bigint("activation_sequence", {
      mode: "number",
    }).generatedAlwaysAsIdentity(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => skillCatalogReleases.releaseId),
    previousReleaseId: uuid("previous_release_id").references(
      () => skillCatalogReleases.releaseId,
    ),
    actorReference: text("actor_reference").notNull(),
    reviewReference: text("review_reference").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("skill_catalog_activation_release_key").on(table.releaseId),
  ],
);

export const craftsmanSpecializations = pgTable(
  "craftsman_specializations",
  {
    id: uuid("id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    craftsmanProfessionId: uuid("craftsman_profession_id")
      .notNull()
      .references(() => craftsmanProfessions.id),
    taxonomyReleaseId: uuid("taxonomy_release_id").notNull(),
    specializationCode: text("specialization_code").notNull(),
    state: craftsmanCapabilityStateEnum("state").notNull().default("ACTIVE"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    deactivatedByUserId: uuid("deactivated_by_user_id").references(
      () => users.id,
    ),
    deactivationCommandId: uuid("deactivation_command_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp("deactivated_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.taxonomyReleaseId, table.specializationCode],
      foreignColumns: [
        taxonomySpecializations.releaseId,
        taxonomySpecializations.specializationCode,
      ],
      name: "craftsman_specializations_taxonomy_fkey",
    }),
    uniqueIndex("craftsman_specializations_one_active")
      .on(table.craftsmanProfileId, table.specializationCode)
      .where(sql`${table.state} = 'ACTIVE'`),
  ],
);

export const craftsmanSpecializationCommands = pgTable(
  "craftsman_specialization_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    commandKind:
      craftsmanSpecializationCommandKindEnum("command_kind").notNull(),
    craftsmanSpecializationId: uuid("craftsman_specialization_id")
      .notNull()
      .references(() => craftsmanSpecializations.id),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const craftsmanSkills = pgTable(
  "craftsman_skills",
  {
    id: uuid("id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    identityKind: craftsmanSkillIdentityKindEnum("identity_kind").notNull(),
    skillCatalogReleaseId: uuid("skill_catalog_release_id"),
    canonicalSkillCode: text("canonical_skill_code"),
    retainedCustomText: text("retained_custom_text"),
    state: craftsmanCapabilityStateEnum("state").notNull().default("ACTIVE"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    deactivatedByUserId: uuid("deactivated_by_user_id").references(
      () => users.id,
    ),
    deactivationCommandId: uuid("deactivation_command_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp("deactivated_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.skillCatalogReleaseId, table.canonicalSkillCode],
      foreignColumns: [
        skillCatalogSkills.releaseId,
        skillCatalogSkills.skillCode,
      ],
      name: "craftsman_skills_catalog_skill_fkey",
    }),
  ],
);

export const craftsmanSkillProfessionLinks = pgTable(
  "craftsman_skill_profession_links",
  {
    craftsmanSkillId: uuid("craftsman_skill_id")
      .notNull()
      .references(() => craftsmanSkills.id),
    craftsmanProfessionId: uuid("craftsman_profession_id")
      .notNull()
      .references(() => craftsmanProfessions.id),
    linkedAt: timestamp("linked_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.craftsmanSkillId, table.craftsmanProfessionId],
    }),
  ],
);

export const craftsmanSkillCommands = pgTable("craftsman_skill_commands", {
  commandId: uuid("command_id").primaryKey(),
  commandKind: craftsmanSkillCommandKindEnum("command_kind").notNull(),
  craftsmanSkillId: uuid("craftsman_skill_id")
    .notNull()
    .references(() => craftsmanSkills.id),
  craftsmanProfileId: uuid("craftsman_profile_id")
    .notNull()
    .references(() => craftsmanProfiles.id),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const craftsmanCustomSkillMappingEvents = pgTable(
  "craftsman_custom_skill_mapping_events",
  {
    eventId: uuid("event_id").primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => craftsmanSkillCommands.commandId),
    craftsmanSkillId: uuid("craftsman_skill_id")
      .notNull()
      .references(() => craftsmanSkills.id),
    revision: integer("revision").notNull(),
    skillCatalogReleaseId: uuid("skill_catalog_release_id").notNull(),
    canonicalSkillCode: text("canonical_skill_code").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("craftsman_custom_skill_mapping_command_key").on(table.commandId),
    unique("craftsman_custom_skill_mapping_revision_key").on(
      table.craftsmanSkillId,
      table.revision,
    ),
    foreignKey({
      columns: [table.skillCatalogReleaseId, table.canonicalSkillCode],
      foreignColumns: [
        skillCatalogSkills.releaseId,
        skillCatalogSkills.skillCode,
      ],
      name: "craftsman_custom_skill_mapping_catalog_fkey",
    }),
    check(
      "craftsman_custom_skill_mapping_revision_positive",
      sql`${table.revision} > 0`,
    ),
  ],
);

export type SkillCatalogReleaseRecord =
  typeof skillCatalogReleases.$inferSelect;
export type SkillCatalogSkillRecord = typeof skillCatalogSkills.$inferSelect;
export type CraftsmanSpecializationRecord =
  typeof craftsmanSpecializations.$inferSelect;
export type CraftsmanSkillRecord = typeof craftsmanSkills.$inferSelect;
