import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  PROFILE_MODERATION_STATES,
  PROFILE_OWNER_VISIBILITY_STATES,
  PROFILE_REVIEW_STATES,
} from "@portal/domain";

import { adminMfaFactors } from "./admin-auth.js";
import { auditEvents } from "./audit.js";
import { craftsmanProfiles } from "./craftsman-profile.js";
import { users } from "./user.js";

export const PROFILE_PUBLICATION_ACTOR_KINDS = [
  "OWNER",
  "ADMIN",
  "SYSTEM",
] as const;
export const PROFILE_PUBLICATION_COMMAND_KINDS = [
  "SUBMIT_REVIEW",
  "SET_OWNER_VISIBILITY",
  "ADMIN_APPROVE",
  "ADMIN_REJECT",
  "MODERATION_HIDE",
  "MODERATION_RESTRICT",
  "MODERATION_RESTORE",
  "IDENTITY_REVIEW_REQUIRED",
] as const;

export const craftsmanProfileReviewStateEnum = pgEnum(
  "craftsman_profile_review_state",
  PROFILE_REVIEW_STATES,
);
export const craftsmanProfileOwnerVisibilityEnum = pgEnum(
  "craftsman_profile_owner_visibility",
  PROFILE_OWNER_VISIBILITY_STATES,
);
export const craftsmanProfileModerationStateEnum = pgEnum(
  "craftsman_profile_moderation_state",
  PROFILE_MODERATION_STATES,
);
export const craftsmanProfilePublicationActorKindEnum = pgEnum(
  "craftsman_profile_publication_actor_kind",
  PROFILE_PUBLICATION_ACTOR_KINDS,
);
export const craftsmanProfilePublicationCommandKindEnum = pgEnum(
  "craftsman_profile_publication_command_kind",
  PROFILE_PUBLICATION_COMMAND_KINDS,
);

function decisionColumns() {
  return {
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
    rejectionReasonCode: text("rejection_reason_code"),
    rejectionUserFacingReason: text("rejection_user_facing_reason"),
    rejectedByUserId: uuid("rejected_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    rejectedAt: timestamp("rejected_at", { mode: "date", withTimezone: true }),
    moderationReasonCategory: text("moderation_reason_category"),
    moderationReasonCode: text("moderation_reason_code"),
    moderationPolicyVersion: text("moderation_policy_version"),
    moderatedByUserId: uuid("moderated_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    moderatedAt: timestamp("moderated_at", {
      mode: "date",
      withTimezone: true,
    }),
    identityReviewReasonCode: text("identity_review_reason_code"),
    identityReviewRuleReference: text("identity_review_rule_reference"),
  };
}

export const craftsmanProfilePublicationCommands = pgTable(
  "craftsman_profile_publication_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    actorKind: craftsmanProfilePublicationActorKindEnum("actor_kind").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    actorSystemReference: text("actor_system_reference"),
    actorCapability: text("actor_capability"),
    authorizationSessionHash: char("authorization_session_hash", {
      length: 64,
    }),
    mfaFactorId: uuid("mfa_factor_id").references(() => adminMfaFactors.id, {
      onDelete: "restrict",
    }),
    mfaAuthenticatedAt: timestamp("mfa_authenticated_at", {
      mode: "date",
      withTimezone: true,
    }),
    correlationId: uuid("correlation_id"),
    auditEventId: uuid("audit_event_id").references(() => auditEvents.eventId, {
      onDelete: "restrict",
    }),
    commandKind:
      craftsmanProfilePublicationCommandKindEnum("command_kind").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    reviewState: craftsmanProfileReviewStateEnum("review_state").notNull(),
    ownerVisibility:
      craftsmanProfileOwnerVisibilityEnum("owner_visibility").notNull(),
    moderationState:
      craftsmanProfileModerationStateEnum("moderation_state").notNull(),
    ...decisionColumns(),
    commandReasonCategory: text("command_reason_category"),
    commandReasonCode: text("command_reason_code"),
    commandPolicyVersion: text("command_policy_version"),
    commandRejectionReasonCode: text("command_rejection_reason_code"),
    commandRejectionUserFacingReason: text(
      "command_rejection_user_facing_reason",
    ),
    commandIdentityReasonCode: text("command_identity_reason_code"),
    commandIdentityRuleReference: text("command_identity_rule_reference"),
    reason: text("reason"),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("craftsman_profile_publication_commands_profile_created_idx").on(
      table.craftsmanProfileId,
      table.createdAt,
      table.commandId,
    ),
    check(
      "craftsman_profile_publication_commands_revision_valid",
      sql`${table.expectedRevision} >= 0 AND ${table.resultingRevision} > 0`,
    ),
  ],
);

export const craftsmanProfilePublicationRevisions = pgTable(
  "craftsman_profile_publication_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    commandId: uuid("command_id")
      .notNull()
      .unique()
      .references(() => craftsmanProfilePublicationCommands.commandId, {
        onDelete: "restrict",
      }),
    revision: integer("revision").notNull(),
    reviewState: craftsmanProfileReviewStateEnum("review_state").notNull(),
    ownerVisibility:
      craftsmanProfileOwnerVisibilityEnum("owner_visibility").notNull(),
    moderationState:
      craftsmanProfileModerationStateEnum("moderation_state").notNull(),
    ...decisionColumns(),
    changedAt: timestamp("changed_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("craftsman_profile_publication_revisions_profile_revision_key").on(
      table.craftsmanProfileId,
      table.revision,
    ),
    check(
      "craftsman_profile_publication_revisions_revision_positive",
      sql`${table.revision} > 0`,
    ),
  ],
);

export type CraftsmanProfilePublicationCommandRecord =
  typeof craftsmanProfilePublicationCommands.$inferSelect;
export type CraftsmanProfilePublicationRevisionRecord =
  typeof craftsmanProfilePublicationRevisions.$inferSelect;
