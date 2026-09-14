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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import {
  CREDENTIAL_QUALIFICATION_REASONS,
  CREDENTIAL_QUALIFICATION_REQUIREMENTS,
} from "@portal/search";

import { credentialTypePolicies } from "./credential-claim.js";
import {
  professionTaxonomyReleases,
  taxonomyContentClassEnum,
  taxonomyProfessions,
  taxonomyReviewStateEnum,
} from "./taxonomy.js";

export const credentialQualificationRequirementEnum = pgEnum(
  "credential_qualification_requirement",
  CREDENTIAL_QUALIFICATION_REQUIREMENTS,
);
export const credentialQualificationEligibilityEnum = pgEnum(
  "credential_qualification_eligibility",
  ["QUALIFIED", "NOT_QUALIFIED"],
);
export const credentialQualificationReasonEnum = pgEnum(
  "credential_qualification_reason",
  CREDENTIAL_QUALIFICATION_REASONS,
);

export const credentialQualificationPolicyReleases = pgTable(
  "credential_qualification_policy_releases",
  {
    releaseId: uuid("release_id").primaryKey(),
    version: integer("version").notNull(),
    taxonomyReleaseId: uuid("taxonomy_release_id")
      .notNull()
      .references(() => professionTaxonomyReleases.releaseId),
    contentClass: taxonomyContentClassEnum("content_class").notNull(),
    reviewState: taxonomyReviewStateEnum("review_state").notNull(),
    reviewReference: text("review_reference"),
    supersedesReleaseId: uuid("supersedes_release_id").references(
      (): AnyPgColumn => credentialQualificationPolicyReleases.releaseId,
    ),
    checksumSha256: char("checksum_sha256", { length: 64 }).notNull(),
    installationTxid: bigint("installation_txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    installedAt: timestamp("installed_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("credential_qualification_policy_releases_version_key").on(
      table.version,
    ),
    unique("credential_qualification_policy_releases_supersedes_key").on(
      table.supersedesReleaseId,
    ),
    unique("credential_qualification_policy_releases_checksum_key").on(
      table.checksumSha256,
    ),
    unique("credential_qualification_policy_releases_release_taxonomy_key").on(
      table.releaseId,
      table.taxonomyReleaseId,
    ),
    check(
      "credential_qualification_release_version_positive",
      sql`${table.version} > 0`,
    ),
    check(
      "credential_qualification_release_checksum_safe",
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const credentialQualificationPolicyEntries = pgTable(
  "credential_qualification_policy_entries",
  {
    releaseId: uuid("release_id").notNull(),
    taxonomyReleaseId: uuid("taxonomy_release_id").notNull(),
    professionCode: text("profession_code").notNull(),
    credentialTypeCode: text("credential_type_code")
      .notNull()
      .references(() => credentialTypePolicies.code),
    requirement:
      credentialQualificationRequirementEnum("requirement").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.releaseId,
        table.professionCode,
        table.credentialTypeCode,
      ],
    }),
    foreignKey({
      columns: [table.releaseId, table.taxonomyReleaseId],
      foreignColumns: [
        credentialQualificationPolicyReleases.releaseId,
        credentialQualificationPolicyReleases.taxonomyReleaseId,
      ],
      name: "credential_qualification_policy_entries_release_taxonomy_fkey",
    }),
    foreignKey({
      columns: [table.taxonomyReleaseId, table.professionCode],
      foreignColumns: [
        taxonomyProfessions.releaseId,
        taxonomyProfessions.professionCode,
      ],
      name: "credential_qualification_policy_entries_profession_fkey",
    }),
  ],
);

export const credentialQualificationPolicyActivationEvents = pgTable(
  "credential_qualification_policy_activation_events",
  {
    activationId: uuid("activation_id").primaryKey(),
    activationSequence: bigint("activation_sequence", {
      mode: "number",
    }).generatedAlwaysAsIdentity(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => credentialQualificationPolicyReleases.releaseId),
    previousReleaseId: uuid("previous_release_id").references(
      () => credentialQualificationPolicyReleases.releaseId,
    ),
    actorReference: text("actor_reference").notNull(),
    reviewReference: text("review_reference").notNull(),
    activatedAt: timestamp("activated_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("credential_qualification_activation_sequence_key").on(
      table.activationSequence,
    ),
    unique("credential_qualification_activation_release_key").on(
      table.releaseId,
    ),
  ],
);

export type CredentialQualificationPolicyReleaseRecord =
  typeof credentialQualificationPolicyReleases.$inferSelect;
export type CredentialQualificationPolicyEntryRecord =
  typeof credentialQualificationPolicyEntries.$inferSelect;
export type CredentialQualificationPolicyActivationRecord =
  typeof credentialQualificationPolicyActivationEvents.$inferSelect;
