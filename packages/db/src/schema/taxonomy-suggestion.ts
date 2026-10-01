import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";

import { craftsmanProfiles } from "./craftsman-profile.js";
import { professionTaxonomyReleases } from "./taxonomy.js";
import { users } from "./user.js";

export const taxonomySuggestionKindEnum = pgEnum("taxonomy_suggestion_kind", [
  "PROFESSION",
  "SERVICE",
]);
export const taxonomySuggestionDecisionEnum = pgEnum(
  "taxonomy_suggestion_decision",
  ["APPROVED_AS_NEW", "MAPPED_TO_EXISTING", "REJECTED"],
);

export const taxonomySuggestions = pgTable(
  "taxonomy_suggestions",
  {
    suggestionId: uuid("suggestion_id").primaryKey(),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references(() => users.id),
    requesterCraftsmanProfileId: uuid("requester_craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    proposedName: text("proposed_name").notNull(),
    proposedDescription: text("proposed_description").notNull(),
    normalizedProposedName: text("normalized_proposed_name").notNull(),
    suggestedKind: taxonomySuggestionKindEnum("suggested_kind"),
    submissionCommandId: uuid("submission_command_id").notNull().unique(),
    submissionFingerprint: char("submission_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("taxonomy_suggestions_pending_owner_idx").on(
      table.requesterCraftsmanProfileId,
      table.createdAt,
      table.suggestionId,
    ),
    check(
      "taxonomy_suggestion_submission_fingerprint_safe",
      sql`${table.submissionFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const taxonomySuggestionDecisions = pgTable(
  "taxonomy_suggestion_decisions",
  {
    decisionId: uuid("decision_id").primaryKey(),
    suggestionId: uuid("suggestion_id")
      .notNull()
      .references(() => taxonomySuggestions.suggestionId),
    decision: taxonomySuggestionDecisionEnum("decision").notNull(),
    decidedByAdminId: uuid("decided_by_admin_id")
      .notNull()
      .references(() => users.id),
    adminDecisionNote: text("admin_decision_note"),
    resolvedTaxonomyKind: taxonomySuggestionKindEnum("resolved_taxonomy_kind"),
    resolvedTaxonomyCode: text("resolved_taxonomy_code"),
    resolvedTaxonomyLabel: text("resolved_taxonomy_label"),
    resultingReleaseId: uuid("resulting_release_id").references(
      () => professionTaxonomyReleases.releaseId,
    ),
    addProposedNameAsAlias: boolean("add_proposed_name_as_alias")
      .notNull()
      .default(false),
    commandId: uuid("command_id").notNull(),
    commandFingerprint: char("command_fingerprint", { length: 64 }).notNull(),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("taxonomy_suggestion_decisions_suggestion_key").on(
      table.suggestionId,
    ),
    unique("taxonomy_suggestion_decisions_command_key").on(table.commandId),
  ],
);
