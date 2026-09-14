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
  uuid,
} from "drizzle-orm/pg-core";

import {
  CAPABILITY_LEVELS,
  TAXONOMY_ALIAS_KINDS,
  TAXONOMY_CONTENT_CLASSES,
  TAXONOMY_ENTRY_STATES,
  TAXONOMY_REVIEW_STATES,
} from "@portal/taxonomy";

export const taxonomyContentClassEnum = pgEnum(
  "taxonomy_content_class",
  TAXONOMY_CONTENT_CLASSES,
);
export const taxonomyReviewStateEnum = pgEnum(
  "taxonomy_review_state",
  TAXONOMY_REVIEW_STATES,
);
export const taxonomyEntryStateEnum = pgEnum(
  "taxonomy_entry_state",
  TAXONOMY_ENTRY_STATES,
);
export const taxonomyCapabilityLevelEnum = pgEnum(
  "taxonomy_capability_level",
  CAPABILITY_LEVELS,
);
export const taxonomyAliasKindEnum = pgEnum(
  "taxonomy_alias_kind",
  TAXONOMY_ALIAS_KINDS,
);
export const taxonomyAliasTargetKindEnum = pgEnum(
  "taxonomy_alias_target_kind",
  ["PROFESSION", "SPECIALIZATION"],
);

export const professionTaxonomyReleases = pgTable(
  "profession_taxonomy_releases",
  {
    releaseId: uuid("release_id").primaryKey(),
    version: integer("version").notNull(),
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
    unique("profession_taxonomy_releases_version_key").on(table.version),
    unique("profession_taxonomy_releases_supersedes_release_id_key").on(
      table.supersedesReleaseId,
    ),
    unique("profession_taxonomy_releases_checksum_sha256_key").on(
      table.checksumSha256,
    ),
    foreignKey({
      columns: [table.supersedesReleaseId],
      foreignColumns: [table.releaseId],
      name: "profession_taxonomy_releases_supersedes_release_id_fkey",
    }),
    check(
      "profession_taxonomy_release_version_positive",
      sql`${table.version} > 0`,
    ),
  ],
);

export const taxonomyProfessions = pgTable(
  "taxonomy_professions",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => professionTaxonomyReleases.releaseId),
    professionCode: text("profession_code").notNull(),
    slug: text("slug").notNull(),
    labelSk: text("label_sk").notNull(),
    state: taxonomyEntryStateEnum("state").notNull(),
    replacedByCode: text("replaced_by_code"),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.professionCode] }),
    unique("taxonomy_professions_release_id_slug_key").on(
      table.releaseId,
      table.slug,
    ),
  ],
);

export const taxonomySpecializations = pgTable(
  "taxonomy_specializations",
  {
    releaseId: uuid("release_id").notNull(),
    specializationCode: text("specialization_code").notNull(),
    professionCode: text("profession_code").notNull(),
    slug: text("slug").notNull(),
    labelSk: text("label_sk").notNull(),
    state: taxonomyEntryStateEnum("state").notNull(),
    replacedByCode: text("replaced_by_code"),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.specializationCode] }),
    unique("taxonomy_specializations_release_id_slug_key").on(
      table.releaseId,
      table.slug,
    ),
    foreignKey({
      columns: [table.releaseId, table.professionCode],
      foreignColumns: [
        taxonomyProfessions.releaseId,
        taxonomyProfessions.professionCode,
      ],
      name: "taxonomy_specializations_profession_fkey",
    }),
  ],
);

export const taxonomyCapabilityCriteria = pgTable(
  "taxonomy_capability_criteria",
  {
    releaseId: uuid("release_id").notNull(),
    criterionCode: text("criterion_code").notNull(),
    professionCode: text("profession_code").notNull(),
    level: taxonomyCapabilityLevelEnum("level").notNull(),
    labelSk: text("label_sk").notNull(),
    descriptionSk: text("description_sk").notNull(),
    state: taxonomyEntryStateEnum("state").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.criterionCode] }),
    foreignKey({
      columns: [table.releaseId, table.professionCode],
      foreignColumns: [
        taxonomyProfessions.releaseId,
        taxonomyProfessions.professionCode,
      ],
      name: "taxonomy_capability_criteria_profession_fkey",
    }),
  ],
);

export const taxonomyAliases = pgTable(
  "taxonomy_aliases",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => professionTaxonomyReleases.releaseId),
    alias: text("alias").notNull(),
    aliasKind: taxonomyAliasKindEnum("alias_kind").notNull(),
    targetKind: taxonomyAliasTargetKindEnum("target_kind").notNull(),
    targetCode: text("target_code").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.aliasKind, table.alias] }),
  ],
);

export const professionTaxonomyActivationEvents = pgTable(
  "profession_taxonomy_activation_events",
  {
    activationId: uuid("activation_id").primaryKey(),
    activationSequence: bigint("activation_sequence", {
      mode: "number",
    }).generatedAlwaysAsIdentity(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => professionTaxonomyReleases.releaseId),
    previousReleaseId: uuid("previous_release_id").references(
      () => professionTaxonomyReleases.releaseId,
    ),
    actorReference: text("actor_reference").notNull(),
    reviewReference: text("review_reference").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("profession_taxonomy_activation_events_release_id_key").on(
      table.releaseId,
    ),
  ],
);

export type ProfessionTaxonomyReleaseRecord =
  typeof professionTaxonomyReleases.$inferSelect;
export type TaxonomyProfessionRecord = typeof taxonomyProfessions.$inferSelect;
export type TaxonomySpecializationRecord =
  typeof taxonomySpecializations.$inferSelect;
