import { createHash } from "node:crypto";

import {
  assertOwnerProfilePublicationCommandInput,
  assertCraftsmanPublicationReadInput,
  assertPrivilegedProfileCommandInput,
  assertRejectCraftsmanProfileInput,
  assertRequireProfileIdentityReviewInput,
  assertRestoreProfileModerationInput,
  assertSetOwnerProfileVisibilityInput,
  assertSetProfileModerationInput,
  PROFILE_IDENTITY_REVIEW_SYSTEM_REFERENCE,
  PROFILE_READINESS_REQUIREMENTS,
  type CraftsmanProfileId,
  type CraftsmanPublicationPersistence,
  type CraftsmanPublicationState,
  type OwnerProfilePublicationCommandInput,
  type PrivilegedProfileCommandInput,
  type ProfileModerationState,
  type ProfileOwnerVisibilityState,
  type ProfilePublicationCommandResult,
  type ProfileReviewState,
  type RejectCraftsmanProfileInput,
  type RequireProfileIdentityReviewInput,
  type RestoreProfileModerationInput,
  type SetOwnerProfileVisibilityInput,
  type SetProfileModerationInput,
  type UserId,
} from "@portal/domain";
import type { AdminCapability } from "@portal/admin-auth";
import type { Sql, TransactionSql } from "postgres";

import { createAuditRepository } from "./audit-repository.js";

type CommandKind =
  | "SUBMIT_REVIEW"
  | "SET_OWNER_VISIBILITY"
  | "ADMIN_APPROVE"
  | "ADMIN_REJECT"
  | "MODERATION_HIDE"
  | "MODERATION_RESTRICT"
  | "MODERATION_RESTORE"
  | "IDENTITY_REVIEW_REQUIRED";
type ActorKind = "OWNER" | "ADMIN" | "SYSTEM";

interface PublicationRow {
  readonly approvedAt: Date | null;
  readonly approvedByUserId: UserId | null;
  readonly changedAt: Date | null;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly effectivelyPublic: boolean;
  readonly identityReviewReasonCode: string | null;
  readonly identityReviewRuleReference: string | null;
  readonly missingRequirements: string[];
  readonly moderatedAt: Date | null;
  readonly moderatedByUserId: UserId | null;
  readonly moderationPolicyVersion: string | null;
  readonly moderationReasonCategory: string | null;
  readonly moderationReasonCode: string | null;
  readonly moderationState: ProfileModerationState;
  readonly ownerVisibility: ProfileOwnerVisibilityState;
  readonly rejectedAt: Date | null;
  readonly rejectedByUserId: UserId | null;
  readonly rejectionReasonCode: string | null;
  readonly rejectionUserFacingReason: string | null;
  readonly reviewState: ProfileReviewState;
  readonly revision: number;
}

interface PersistedCommandRow {
  readonly actorKind: ActorKind;
  readonly actorUserId: UserId | null;
  readonly commandKind: CommandKind;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

interface CommandSpec {
  readonly actorKind: ActorKind;
  readonly actorUserId: UserId | null;
  readonly capability: AdminCapability | null;
  readonly commandId: string;
  readonly commandKind: CommandKind;
  readonly correlationId: string | null;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
  readonly fingerprint: string;
  readonly identityReasonCode?: string;
  readonly identityRuleReference?: string;
  readonly ownerVisibility?: ProfileOwnerVisibilityState;
  readonly policyVersion?: string;
  readonly reason?: string;
  readonly reasonCategory?: string;
  readonly reasonCode?: string;
  readonly rejectionReasonCode?: string;
  readonly rejectionUserFacingReason?: string;
  readonly sessionDigest?: string;
}

export class CraftsmanPublicationIdempotencyError extends Error {
  readonly code = "CRAFTSMAN_PUBLICATION_IDEMPOTENCY_CONFLICT";
}

export function createCraftsmanPublicationRepository(
  sql: Sql,
): CraftsmanPublicationPersistence {
  return Object.freeze({
    async submitForReview(input: OwnerProfilePublicationCommandInput) {
      assertOwnerProfilePublicationCommandInput(input);
      return execute(sql, ownerSpec("SUBMIT_REVIEW", input));
    },
    async setOwnerVisibility(input: SetOwnerProfileVisibilityInput) {
      assertSetOwnerProfileVisibilityInput(input);
      return execute(sql, {
        ...ownerSpec("SET_OWNER_VISIBILITY", input),
        ownerVisibility: input.visibility,
      });
    },
    async approve(input: PrivilegedProfileCommandInput) {
      assertPrivilegedProfileCommandInput(input);
      return execute(
        sql,
        adminSpec("ADMIN_APPROVE", "admin.profiles.review", input),
      );
    },
    async reject(input: RejectCraftsmanProfileInput) {
      assertRejectCraftsmanProfileInput(input);
      return execute(sql, {
        ...adminSpec("ADMIN_REJECT", "admin.profiles.review", input),
        rejectionReasonCode: input.reasonCode,
        rejectionUserFacingReason: input.userFacingReason,
      });
    },
    async setModeration(input: SetProfileModerationInput) {
      assertSetProfileModerationInput(input);
      return execute(sql, {
        ...adminSpec(
          input.moderationState === "HIDDEN"
            ? "MODERATION_HIDE"
            : "MODERATION_RESTRICT",
          "admin.profiles.moderate",
          input,
        ),
        policyVersion: input.policyVersion,
        reasonCategory: input.reasonCategory,
        reasonCode: input.reasonCode,
      });
    },
    async restoreModeration(input: RestoreProfileModerationInput) {
      assertRestoreProfileModerationInput(input);
      return execute(sql, {
        ...adminSpec("MODERATION_RESTORE", "admin.profiles.moderate", input),
        policyVersion: input.policyVersion,
        reasonCategory: input.reasonCategory,
        reasonCode: input.reasonCode,
      });
    },
    async requireIdentityReview(input: RequireProfileIdentityReviewInput) {
      assertRequireProfileIdentityReviewInput(input);
      const spec: CommandSpec = {
        actorKind: "SYSTEM",
        actorUserId: null,
        capability: null,
        commandId: input.commandId,
        commandKind: "IDENTITY_REVIEW_REQUIRED",
        correlationId: null,
        craftsmanProfileId: input.craftsmanProfileId,
        expectedRevision: input.expectedRevision,
        fingerprint: fingerprint("IDENTITY_REVIEW_REQUIRED", input),
        identityReasonCode: input.reasonCode,
        identityRuleReference: input.ruleReference,
      };
      return execute(sql, spec);
    },
    async findOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
    }) {
      assertCraftsmanPublicationReadInput(input);
      const [row] = await sql<PublicationRow[]>`
        SELECT
          publication.craftsman_profile_id AS "craftsmanProfileId",
          publication.revision, publication.review_state AS "reviewState",
          publication.owner_visibility AS "ownerVisibility",
          publication.moderation_state AS "moderationState",
          publication.approved_by_user_id AS "approvedByUserId",
          publication.approved_at AS "approvedAt",
          publication.rejection_reason_code AS "rejectionReasonCode",
          publication.rejection_user_facing_reason AS "rejectionUserFacingReason",
          publication.rejected_by_user_id AS "rejectedByUserId",
          publication.rejected_at AS "rejectedAt",
          publication.moderation_reason_category AS "moderationReasonCategory",
          publication.moderation_reason_code AS "moderationReasonCode",
          publication.moderation_policy_version AS "moderationPolicyVersion",
          publication.moderated_by_user_id AS "moderatedByUserId",
          publication.moderated_at AS "moderatedAt",
          publication.identity_review_reason_code AS "identityReviewReasonCode",
          publication.identity_review_rule_reference AS "identityReviewRuleReference",
          publication.missing_requirements AS "missingRequirements",
          publication.effectively_public AS "effectivelyPublic",
          publication.changed_at AS "changedAt"
        FROM current_craftsman_profile_publications publication
        JOIN users owner ON owner.id = publication.owner_user_id
        WHERE publication.craftsman_profile_id = ${input.craftsmanProfileId}
          AND publication.owner_user_id = ${input.actorUserId}
          AND owner.account_state = 'ACTIVE'
      `;
      return row === undefined ? null : toPublication(row);
    },
  });
}

function ownerSpec(
  kind: "SUBMIT_REVIEW" | "SET_OWNER_VISIBILITY",
  input: OwnerProfilePublicationCommandInput | SetOwnerProfileVisibilityInput,
): CommandSpec {
  return {
    actorKind: "OWNER",
    actorUserId: input.actorUserId,
    capability: null,
    commandId: input.commandId,
    commandKind: kind,
    correlationId: null,
    craftsmanProfileId: input.craftsmanProfileId,
    expectedRevision: input.expectedRevision,
    fingerprint: fingerprint(kind, input),
  };
}

function adminSpec(
  kind: Exclude<
    CommandKind,
    "SUBMIT_REVIEW" | "SET_OWNER_VISIBILITY" | "IDENTITY_REVIEW_REQUIRED"
  >,
  capability: AdminCapability,
  input:
    | PrivilegedProfileCommandInput
    | RejectCraftsmanProfileInput
    | SetProfileModerationInput
    | RestoreProfileModerationInput,
): CommandSpec {
  return {
    actorKind: "ADMIN",
    actorUserId: input.actorUserId,
    capability,
    commandId: input.commandId,
    commandKind: kind,
    correlationId: input.correlationId,
    craftsmanProfileId: input.craftsmanProfileId,
    expectedRevision: input.expectedRevision,
    fingerprint: fingerprint(kind, {
      ...input,
      actorSessionIdDigest: undefined,
    }),
    reason: input.reason,
    sessionDigest: input.actorSessionIdDigest,
  };
}

async function execute(
  sql: Sql,
  spec: CommandSpec,
): Promise<ProfilePublicationCommandResult> {
  return sql.begin(async (transaction) => {
    if (spec.actorKind === "OWNER") {
      if (!(await lockActiveOwner(transaction, spec))) {
        return Object.freeze({ status: "PROFILE_UNAVAILABLE" });
      }
    } else if (spec.actorKind === "ADMIN") {
      if (!(await lockAuthorizedAdmin(transaction, spec))) {
        return Object.freeze({ status: "ADMIN_AUTHORIZATION_REQUIRED" });
      }
    } else if (!(await lockProfile(transaction, spec.craftsmanProfileId))) {
      return Object.freeze({ status: "PROFILE_UNAVAILABLE" });
    }

    const replay = await replayCommand(transaction, spec);
    if (replay !== null) return replay;

    const current = await selectCurrent(transaction, spec.craftsmanProfileId);
    if (current === null)
      return Object.freeze({ status: "PROFILE_UNAVAILABLE" });
    if (current.revision !== spec.expectedRevision) {
      return Object.freeze({ status: "STALE_REVISION" });
    }
    if (
      (spec.commandKind === "SUBMIT_REVIEW" ||
        spec.commandKind === "ADMIN_APPROVE") &&
      current.missingRequirements.length > 0
    ) {
      return Object.freeze({
        readiness: readiness(current),
        status: "NOT_READY",
      });
    }
    if (!validTransition(current, spec)) {
      return Object.freeze({ status: "INVALID_TRANSITION" });
    }
    if (
      spec.commandKind === "SET_OWNER_VISIBILITY" &&
      current.ownerVisibility === spec.ownerVisibility
    ) {
      return Object.freeze({
        publication: toPublication(current),
        status: "UNCHANGED",
      });
    }

    await insertCommand(transaction, spec, current);
    await transaction`
      INSERT INTO craftsman_profile_publication_revisions (
        craftsman_profile_id, command_id, revision,
        review_state, owner_visibility, moderation_state
      ) VALUES (
        ${spec.craftsmanProfileId}, ${spec.commandId}, ${spec.expectedRevision + 1},
        'DRAFT', 'HIDDEN', 'ALLOWED'
      )
    `;
    const applied = await selectRevision(
      transaction,
      spec.craftsmanProfileId,
      spec.expectedRevision + 1,
    );
    if (applied === null)
      throw new Error("Publication command effect missing.");
    if (spec.actorKind === "ADMIN") {
      await appendAdminAudit(transaction, spec, current, applied);
    } else if (spec.actorKind === "SYSTEM") {
      await appendSystemAudit(transaction, spec, current, applied);
    }
    return Object.freeze({
      publication: toPublication(applied),
      status: "APPLIED",
    });
  });
}

function validTransition(current: PublicationRow, spec: CommandSpec): boolean {
  switch (spec.commandKind) {
    case "SUBMIT_REVIEW":
      return (
        current.reviewState === "DRAFT" || current.reviewState === "REJECTED"
      );
    case "ADMIN_APPROVE":
    case "ADMIN_REJECT":
      return current.reviewState === "PENDING";
    case "MODERATION_RESTORE":
      return current.moderationState !== "ALLOWED";
    case "IDENTITY_REVIEW_REQUIRED":
      return current.reviewState === "APPROVED";
    default:
      return true;
  }
}

async function insertCommand(
  transaction: TransactionSql,
  spec: CommandSpec,
  current: PublicationRow,
): Promise<void> {
  await transaction`
    INSERT INTO craftsman_profile_publication_commands (
      command_id, craftsman_profile_id, actor_kind, actor_user_id,
      actor_system_reference, actor_capability, authorization_session_hash,
      correlation_id, audit_event_id, command_kind, expected_revision, resulting_revision,
      review_state, owner_visibility, moderation_state,
      command_rejection_reason_code, command_rejection_user_facing_reason,
      command_identity_reason_code, command_identity_rule_reference,
      command_reason_category, command_reason_code, command_policy_version,
      reason, payload_fingerprint
    ) VALUES (
      ${spec.commandId}, ${spec.craftsmanProfileId}, ${spec.actorKind},
      ${spec.actorUserId},
      ${spec.actorKind === "SYSTEM" ? PROFILE_IDENTITY_REVIEW_SYSTEM_REFERENCE : null},
      ${spec.capability}, ${spec.sessionDigest ?? null}, ${spec.correlationId},
      ${spec.actorKind === "OWNER" ? null : spec.commandId},
      ${spec.commandKind}, ${spec.expectedRevision}, ${spec.expectedRevision + 1},
      ${current.reviewState}, ${spec.ownerVisibility ?? current.ownerVisibility},
      ${current.moderationState}, ${spec.rejectionReasonCode ?? null},
      ${spec.rejectionUserFacingReason ?? null}, ${spec.identityReasonCode ?? null},
      ${spec.identityRuleReference ?? null}, ${spec.reasonCategory ?? null},
      ${spec.reasonCode ?? null}, ${spec.policyVersion ?? null}, ${spec.reason ?? null},
      ${spec.fingerprint}
    )
  `;
}

async function replayCommand(
  transaction: TransactionSql,
  spec: CommandSpec,
): Promise<ProfilePublicationCommandResult | null> {
  const [existing] = await transaction<PersistedCommandRow[]>`
    SELECT actor_kind AS "actorKind", actor_user_id AS "actorUserId",
      command_kind AS "commandKind", craftsman_profile_id AS "craftsmanProfileId",
      payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision"
    FROM craftsman_profile_publication_commands
    WHERE command_id = ${spec.commandId}
  `;
  if (existing === undefined) return null;
  if (
    existing.actorKind !== spec.actorKind ||
    existing.actorUserId !== spec.actorUserId ||
    existing.commandKind !== spec.commandKind ||
    existing.craftsmanProfileId !== spec.craftsmanProfileId ||
    existing.payloadFingerprint !== spec.fingerprint
  ) {
    throw new CraftsmanPublicationIdempotencyError(
      "Publication command id was reused with different authority or payload.",
    );
  }
  const historical = await selectRevision(
    transaction,
    spec.craftsmanProfileId,
    existing.resultingRevision,
  );
  if (historical === null)
    throw new Error("Persisted publication effect missing.");
  return Object.freeze({
    publication: toPublication(historical),
    status: "DEDUPLICATED",
  });
}

async function lockActiveOwner(
  transaction: TransactionSql,
  spec: CommandSpec,
): Promise<boolean> {
  const rows = await transaction`
    SELECT profile.id
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${spec.craftsmanProfileId}
      AND profile.owner_user_id = ${spec.actorUserId}
      AND owner.account_state = 'ACTIVE'
    FOR UPDATE OF profile, owner
  `;
  return rows.length === 1;
}

async function lockProfile(
  transaction: TransactionSql,
  profileId: CraftsmanProfileId,
): Promise<boolean> {
  const rows = await transaction`
    SELECT id FROM craftsman_profiles WHERE id = ${profileId} FOR UPDATE
  `;
  return rows.length === 1;
}

async function lockAuthorizedAdmin(
  transaction: TransactionSql,
  spec: CommandSpec,
): Promise<boolean> {
  const rows = await transaction`
    SELECT privileged.session_id_hash
    FROM admin_privileged_sessions privileged
    JOIN auth_sessions session ON session.session_id_hash = privileged.session_id_hash
      AND session.user_id = privileged.user_id
    JOIN users actor ON actor.id = privileged.user_id
    JOIN admin_mfa_factors factor ON factor.id = privileged.mfa_factor_id
      AND factor.user_id = privileged.user_id
    JOIN admin_role_grants role_grant ON role_grant.user_id = privileged.user_id
      AND role_grant.role IN ('ADMIN', 'SUPER_ADMIN')
      AND role_grant.revoked_at IS NULL
    WHERE privileged.session_id_hash = ${spec.sessionDigest ?? null}
      AND privileged.user_id = ${spec.actorUserId}
      AND privileged.revoked_at IS NULL
      AND privileged.expires_at > clock_timestamp()
      AND session.revoked_at IS NULL
      AND session.expires_at > clock_timestamp()
      AND actor.account_state = 'ACTIVE'
      AND factor.revoked_at IS NULL
      AND privileged.mfa_authenticated_at >= clock_timestamp() - interval '10 minutes'
    ORDER BY role_grant.role DESC
    LIMIT 1
    FOR UPDATE OF privileged, session, actor, factor, role_grant
  `;
  return rows.length === 1;
}

async function selectCurrent(
  sql: TransactionSql | Sql,
  profileId: CraftsmanProfileId,
): Promise<PublicationRow | null> {
  const [row] = await sql<PublicationRow[]>`
    SELECT
      publication.craftsman_profile_id AS "craftsmanProfileId",
      publication.revision, publication.review_state AS "reviewState",
      publication.owner_visibility AS "ownerVisibility",
      publication.moderation_state AS "moderationState",
      publication.approved_by_user_id AS "approvedByUserId",
      publication.approved_at AS "approvedAt",
      publication.rejection_reason_code AS "rejectionReasonCode",
      publication.rejection_user_facing_reason AS "rejectionUserFacingReason",
      publication.rejected_by_user_id AS "rejectedByUserId",
      publication.rejected_at AS "rejectedAt",
      publication.moderation_reason_category AS "moderationReasonCategory",
      publication.moderation_reason_code AS "moderationReasonCode",
      publication.moderation_policy_version AS "moderationPolicyVersion",
      publication.moderated_by_user_id AS "moderatedByUserId",
      publication.moderated_at AS "moderatedAt",
      publication.identity_review_reason_code AS "identityReviewReasonCode",
      publication.identity_review_rule_reference AS "identityReviewRuleReference",
      publication.missing_requirements AS "missingRequirements",
      publication.effectively_public AS "effectivelyPublic",
      publication.changed_at AS "changedAt"
    FROM current_craftsman_profile_publications publication
    WHERE publication.craftsman_profile_id = ${profileId}
  `;
  return row ?? null;
}

async function selectRevision(
  sql: TransactionSql,
  profileId: CraftsmanProfileId,
  revision: number,
): Promise<PublicationRow | null> {
  const [row] = await sql<PublicationRow[]>`
    SELECT
      stored.craftsman_profile_id AS "craftsmanProfileId",
      stored.revision, stored.review_state AS "reviewState",
      stored.owner_visibility AS "ownerVisibility",
      stored.moderation_state AS "moderationState",
      stored.approved_by_user_id AS "approvedByUserId",
      stored.approved_at AS "approvedAt",
      stored.rejection_reason_code AS "rejectionReasonCode",
      stored.rejection_user_facing_reason AS "rejectionUserFacingReason",
      stored.rejected_by_user_id AS "rejectedByUserId",
      stored.rejected_at AS "rejectedAt",
      stored.moderation_reason_category AS "moderationReasonCategory",
      stored.moderation_reason_code AS "moderationReasonCode",
      stored.moderation_policy_version AS "moderationPolicyVersion",
      stored.moderated_by_user_id AS "moderatedByUserId",
      stored.moderated_at AS "moderatedAt",
      stored.identity_review_reason_code AS "identityReviewReasonCode",
      stored.identity_review_rule_reference AS "identityReviewRuleReference",
      craftsman_profile_missing_publication_requirements(stored.craftsman_profile_id)
        AS "missingRequirements",
      (
        current.revision = stored.revision AND current.effectively_public
      ) AS "effectivelyPublic",
      stored.changed_at AS "changedAt"
    FROM craftsman_profile_publication_revisions stored
    JOIN current_craftsman_profile_publications current
      ON current.craftsman_profile_id = stored.craftsman_profile_id
    WHERE stored.craftsman_profile_id = ${profileId}
      AND stored.revision = ${revision}
  `;
  return row ?? null;
}

async function appendAdminAudit(
  transaction: TransactionSql,
  spec: CommandSpec,
  before: PublicationRow,
  after: PublicationRow,
): Promise<void> {
  const moderation = spec.commandKind.startsWith("MODERATION_");
  await createAuditRepository(transaction).append({
    action: actionFor(spec.commandKind),
    actor: {
      capability: required(spec.capability),
      kind: "AUTHENTICATED_USER",
      userId: required(spec.actorUserId),
    },
    category: "PRIVILEGED_COMMAND",
    changes: moderation
      ? {
          restriction_state: {
            after: after.moderationState,
            before: before.moderationState,
          },
        }
      : {
          profile_state: {
            after: after.reviewState,
            before: before.reviewState,
          },
        },
    correlationId: required(spec.correlationId),
    eventId: spec.commandId,
    reason: required(spec.reason),
    target: { id: spec.craftsmanProfileId, type: "CRAFTSMAN_PROFILE" },
  });
}

async function appendSystemAudit(
  transaction: TransactionSql,
  spec: CommandSpec,
  before: PublicationRow,
  after: PublicationRow,
): Promise<void> {
  await createAuditRepository(transaction).append({
    action: "system.profile.identity_review_required",
    actor: {
      kind: "SYSTEM",
      systemReference: PROFILE_IDENTITY_REVIEW_SYSTEM_REFERENCE,
    },
    category: "SECURITY_EVENT",
    changes: {
      profile_state: {
        after: after.reviewState,
        before: before.reviewState,
      },
    },
    correlationId: spec.commandId,
    eventId: spec.commandId,
    target: { id: spec.craftsmanProfileId, type: "CRAFTSMAN_PROFILE" },
  });
}

function actionFor(kind: CommandKind): string {
  switch (kind) {
    case "ADMIN_APPROVE":
      return "admin.profile.approved";
    case "ADMIN_REJECT":
      return "admin.profile.rejected";
    case "MODERATION_HIDE":
      return "admin.profile.hidden";
    case "MODERATION_RESTRICT":
      return "admin.profile.restricted";
    case "MODERATION_RESTORE":
      return "admin.profile.restored";
    default:
      throw new Error("Owner/system command has no admin audit action.");
  }
}

function toPublication(row: PublicationRow): CraftsmanPublicationState {
  return Object.freeze({
    approved:
      row.approvedByUserId === null || row.approvedAt === null
        ? null
        : Object.freeze({
            actorUserId: row.approvedByUserId,
            occurredAt: row.approvedAt,
          }),
    changedAt: row.changedAt,
    craftsmanProfileId: row.craftsmanProfileId,
    effectivelyPublic: row.effectivelyPublic,
    moderation:
      row.moderatedByUserId === null ||
      row.moderatedAt === null ||
      row.moderationPolicyVersion === null ||
      row.moderationReasonCategory === null ||
      row.moderationReasonCode === null
        ? null
        : Object.freeze({
            actorUserId: row.moderatedByUserId,
            occurredAt: row.moderatedAt,
            policyVersion: row.moderationPolicyVersion,
            reasonCategory: row.moderationReasonCategory,
            reasonCode: row.moderationReasonCode,
          }),
    moderationState: row.moderationState,
    ownerVisibility: row.ownerVisibility,
    readiness: readiness(row),
    rejection:
      row.rejectedByUserId === null ||
      row.rejectedAt === null ||
      row.rejectionReasonCode === null ||
      row.rejectionUserFacingReason === null
        ? null
        : Object.freeze({
            actorUserId: row.rejectedByUserId,
            occurredAt: row.rejectedAt,
            reasonCode: row.rejectionReasonCode,
            userFacingReason: row.rejectionUserFacingReason,
          }),
    reviewState: row.reviewState,
    revision: row.revision,
  });
}

function readiness(
  row: PublicationRow,
): CraftsmanPublicationState["readiness"] {
  const missing = row.missingRequirements.map((item) => {
    const value = PROFILE_READINESS_REQUIREMENTS.find(
      (candidate) => candidate === item,
    );
    if (value === undefined)
      throw new Error("Invalid persisted readiness requirement.");
    return value;
  });
  return Object.freeze({
    isReady: missing.length === 0,
    missing: Object.freeze(missing),
  });
}

function fingerprint(kind: CommandKind, input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ input, kind }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Required command fact missing.");
  return value;
}
