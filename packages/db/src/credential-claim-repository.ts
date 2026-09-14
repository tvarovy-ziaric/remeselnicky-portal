import { createHash } from "node:crypto";

import type { AdminAccessService, PrivilegedActor } from "@portal/admin-auth";
import { auditActorFromPrivilegedActor } from "@portal/audit";
import {
  assertAttachCredentialEvidenceInput,
  assertCreateCredentialClaimInput,
  assertCredentialClaimListInput,
  normalizeCredentialReviewCommand,
  type AttachCredentialEvidenceInput,
  type AttachCredentialEvidenceResult,
  type CreateCredentialClaimInput,
  type CreateCredentialClaimResult,
  type CredentialClaim,
  type CredentialClaimId,
  type CredentialClaimPersistence,
  type CredentialClaimState,
  type CredentialEvidenceReference,
  type CredentialEvidenceRequirement,
  type CredentialReviewCommand,
  type CredentialReviewReasonCategory,
  type CraftsmanProfileId,
  type UserId,
} from "@portal/domain";
import {
  createServerMediaProvenance,
  type MediaUploadPurpose,
  type ServerMediaProvenance,
} from "@portal/media";
import type { Sql, TransactionSql } from "postgres";

import { createAuditRepository } from "./audit-repository.js";

type CredentialCommandKind =
  "CREATE" | "ATTACH_EVIDENCE" | "APPROVE" | "REJECT" | "REVOKE";

interface CredentialClaimRow {
  readonly craftsmanProfessionId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly credentialTypeCode: string;
  readonly evidenceRequirement: CredentialEvidenceRequirement;
  readonly expiresOn: string | null;
  readonly id: CredentialClaimId;
  readonly reviewReason: string | null;
  readonly reviewReasonCategory: CredentialReviewReasonCategory | null;
  readonly reviewedAt: Date | null;
  readonly revision: number;
  readonly state: CredentialClaimState;
  readonly updatedAt: Date;
}

interface EvidenceRow {
  readonly attachedAt: Date;
  readonly mediaAssetId: string;
  readonly mediaKind: "DOCUMENT" | "IMAGE";
}

interface CommandRow extends CredentialClaimRow {
  readonly actorUserId: UserId;
  readonly commandKind: CredentialCommandKind;
  readonly commandProfileId: CraftsmanProfileId;
  readonly payloadFingerprint: string;
}

export type CredentialReviewResult = Readonly<
  | { status: "APPLIED" | "DEDUPLICATED"; claim: CredentialClaim }
  | {
      status:
        | "CLAIM_UNAVAILABLE"
        | "INVALID_TRANSITION"
        | "REQUIRED_EVIDENCE_MISSING"
        | "STALE_REVISION";
    }
>;

export type CredentialReviewServiceResult =
  CredentialReviewResult | Readonly<{ status: "AUTHORIZATION_DENIED" }>;

interface AuthorizedReviewInput {
  readonly actor: PrivilegedActor;
  readonly privilegedSessionIdHash: string;
  readonly command: CredentialReviewCommand;
}

interface AuthorizedQueueInput {
  readonly actor: PrivilegedActor;
  readonly privilegedSessionIdHash: string;
}

export interface CredentialClaimRepository extends CredentialClaimPersistence {
  listPendingAuthorized(
    input: AuthorizedQueueInput,
  ): Promise<readonly CredentialClaim[]>;
  prepareEvidenceUpload(input: {
    readonly actorUserId: UserId;
    readonly claimId: CredentialClaimId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly expectedRevision: number;
    readonly mediaKind: "DOCUMENT" | "IMAGE";
  }): Promise<
    | Readonly<{
        provenance: ServerMediaProvenance;
        purpose: MediaUploadPurpose;
        status: "READY";
      }>
    | Readonly<{
        status:
          | "PROFILE_UNAVAILABLE"
          | "CLAIM_UNAVAILABLE"
          | "CLAIM_NOT_PENDING"
          | "STALE_REVISION";
      }>
  >;
  reviewAuthorized(
    input: AuthorizedReviewInput,
  ): Promise<CredentialReviewResult>;
}

export interface CredentialReviewService {
  listPending(input: {
    readonly actorUserId: UserId;
    readonly privilegedSessionId: string;
  }): Promise<
    readonly CredentialClaim[] | { readonly status: "AUTHORIZATION_DENIED" }
  >;
  review(input: {
    readonly actorUserId: UserId;
    readonly privilegedSessionId: string;
    readonly command: CredentialReviewCommand;
  }): Promise<CredentialReviewServiceResult>;
}

export class CredentialClaimIdempotencyError extends Error {
  readonly code = "CREDENTIAL_CLAIM_IDEMPOTENCY_CONFLICT";
}

export function createCredentialClaimRepository(
  sql: Sql,
): CredentialClaimRepository {
  return Object.freeze({
    async create(
      input: CreateCredentialClaimInput,
    ): Promise<CreateCredentialClaimResult> {
      assertCreateCredentialClaimInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" };
        }
        const fingerprint = fingerprintCommand("CREATE", input);
        const replay = await findCommandReplay(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactOwnerReplay(replay, "CREATE", input, fingerprint);
          return {
            claim: await hydrateReplay(transaction, replay),
            status: "DEDUPLICATED",
          };
        }
        if (!(await professionAvailable(transaction, input))) {
          return { status: "PROFESSION_UNAVAILABLE" };
        }
        if (!(await typeAvailable(transaction, input.credentialTypeCode))) {
          return { status: "TYPE_UNAVAILABLE" };
        }
        const [existing] = await transaction<{ readonly id: string }[]>`
          SELECT id FROM credential_claims WHERE id = ${input.claimId}
        `;
        if (existing !== undefined) return { status: "CLAIM_ALREADY_EXISTS" };

        await transaction`
          INSERT INTO credential_claims (
            id, craftsman_profile_id, craftsman_profession_id,
            credential_type_code, evidence_requirement, expires_on,
            latest_command_id, created_by_user_id, updated_by_user_id
          ) VALUES (
            ${input.claimId}, ${input.craftsmanProfileId}, ${input.craftsmanProfessionId},
            ${input.credentialTypeCode}, 'OPTIONAL', ${input.expiresOn ?? null},
            ${input.commandId}, ${input.actorUserId}, ${input.actorUserId}
          )
        `;
        await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          claimId: input.claimId,
          commandId: input.commandId,
          commandKind: "CREATE",
          craftsmanProfileId: input.craftsmanProfileId,
          expectedRevision: 0,
          fingerprint,
        });
        await insertCurrentRevision(transaction, input.claimId);
        return {
          claim: await getCurrentClaim(transaction, input.claimId),
          status: "APPLIED",
        };
      });
    },

    async attachEvidence(
      input: AttachCredentialEvidenceInput,
    ): Promise<AttachCredentialEvidenceResult> {
      assertAttachCredentialEvidenceInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" };
        }
        const fingerprint = fingerprintCommand("ATTACH_EVIDENCE", input);
        const replay = await findCommandReplay(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactOwnerReplay(replay, "ATTACH_EVIDENCE", input, fingerprint);
          return {
            claim: await hydrateReplay(transaction, replay),
            status: "DEDUPLICATED",
          };
        }
        const current = await lockClaim(
          transaction,
          input.claimId,
          input.craftsmanProfileId,
        );
        if (current === undefined) return { status: "CLAIM_UNAVAILABLE" };
        if (current.state !== "PENDING") return { status: "CLAIM_NOT_PENDING" };
        if (current.revision !== input.expectedRevision)
          return { status: "STALE_REVISION" };
        const evidence = await loadAttachableEvidence(transaction, input);
        if (evidence === undefined) return { status: "EVIDENCE_UNAVAILABLE" };
        const [alreadyAttached] = await transaction<
          { readonly claimId: string }[]
        >`
          SELECT claim_id AS "claimId" FROM credential_claim_evidence
          WHERE media_asset_id = ${input.mediaAssetId}
        `;
        if (alreadyAttached !== undefined)
          return { status: "EVIDENCE_ALREADY_ATTACHED" };

        await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          claimId: input.claimId,
          commandId: input.commandId,
          commandKind: "ATTACH_EVIDENCE",
          craftsmanProfileId: input.craftsmanProfileId,
          expectedRevision: input.expectedRevision,
          fingerprint,
          mediaAssetId: input.mediaAssetId,
        });
        await transaction`
          INSERT INTO credential_claim_evidence (
            claim_id, media_asset_id, command_id, attached_revision,
            media_kind, attached_by_user_id
          ) VALUES (
            ${input.claimId}, ${input.mediaAssetId}, ${input.commandId},
            ${input.expectedRevision + 1}, ${evidence.mediaKind}, ${input.actorUserId}
          )
        `;
        await transaction`
          UPDATE credential_claims SET latest_command_id = ${input.commandId}
          WHERE id = ${input.claimId}
        `;
        await insertCurrentRevision(transaction, input.claimId);
        return {
          claim: await getCurrentClaim(transaction, input.claimId),
          status: "APPLIED",
        };
      });
    },

    async listOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
    }): Promise<readonly CredentialClaim[]> {
      assertCredentialClaimListInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) return [];
        const rows = await transaction<CredentialClaimRow[]>`
          SELECT claim.id, claim.craftsman_profile_id AS "craftsmanProfileId",
            claim.craftsman_profession_id AS "craftsmanProfessionId",
            claim.credential_type_code AS "credentialTypeCode",
            claim.evidence_requirement AS "evidenceRequirement",
            claim.expires_on::text AS "expiresOn", claim.state, claim.revision,
            claim.review_reason_category AS "reviewReasonCategory",
            claim.review_reason AS "reviewReason", claim.reviewed_at AS "reviewedAt",
            claim.created_at AS "createdAt", claim.updated_at AS "updatedAt"
          FROM credential_claims claim
          WHERE claim.craftsman_profile_id = ${input.craftsmanProfileId}
          ORDER BY claim.created_at, claim.id
        `;
        return hydrateClaims(transaction, rows);
      });
    },

    async listPendingAuthorized(
      input: AuthorizedQueueInput,
    ): Promise<readonly CredentialClaim[]> {
      assertAuthorizedActor(input.actor);
      return sql.begin(async (transaction) => {
        if (!(await privilegedSessionValid(transaction, input))) return [];
        const rows = await transaction<CredentialClaimRow[]>`
          SELECT claim.id, claim.craftsman_profile_id AS "craftsmanProfileId",
            claim.craftsman_profession_id AS "craftsmanProfessionId",
            claim.credential_type_code AS "credentialTypeCode",
            claim.evidence_requirement AS "evidenceRequirement",
            claim.expires_on::text AS "expiresOn", claim.state, claim.revision,
            claim.review_reason_category AS "reviewReasonCategory",
            claim.review_reason AS "reviewReason", claim.reviewed_at AS "reviewedAt",
            claim.created_at AS "createdAt", claim.updated_at AS "updatedAt"
          FROM credential_claims claim
          WHERE claim.state = 'PENDING'
          ORDER BY claim.created_at, claim.id
        `;
        return hydrateClaims(transaction, rows);
      });
    },

    async prepareEvidenceUpload(input: {
      readonly actorUserId: UserId;
      readonly claimId: CredentialClaimId;
      readonly craftsmanProfileId: CraftsmanProfileId;
      readonly expectedRevision: number;
      readonly mediaKind: "DOCUMENT" | "IMAGE";
    }) {
      assertEvidenceUploadPreparationInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const claim = await lockClaim(
          transaction,
          input.claimId,
          input.craftsmanProfileId,
        );
        if (claim === undefined)
          return { status: "CLAIM_UNAVAILABLE" } as const;
        if (claim.state !== "PENDING")
          return { status: "CLAIM_NOT_PENDING" } as const;
        if (claim.revision !== input.expectedRevision) {
          return { status: "STALE_REVISION" } as const;
        }
        return Object.freeze({
          provenance: createServerMediaProvenance({
            entityId: claim.id,
            entityRevision: claim.revision,
            entityType: "CREDENTIAL",
          }),
          purpose:
            input.mediaKind === "DOCUMENT"
              ? ("CREDENTIAL_DOCUMENT" as const)
              : ("CREDENTIAL_IMAGE" as const),
          status: "READY" as const,
        });
      });
    },

    async reviewAuthorized(
      input: AuthorizedReviewInput,
    ): Promise<CredentialReviewResult> {
      assertAuthorizedActor(input.actor);
      const command = normalizeCredentialReviewCommand(input.command);
      return sql.begin(async (transaction) => {
        if (!(await privilegedSessionValid(transaction, input))) {
          return { status: "CLAIM_UNAVAILABLE" };
        }
        const current = await lockClaimById(transaction, command.claimId);
        if (current === undefined) return { status: "CLAIM_UNAVAILABLE" };
        const kind =
          command.decision === "APPROVE"
            ? "APPROVE"
            : command.decision === "REJECT"
              ? "REJECT"
              : "REVOKE";
        const fingerprint = fingerprintCommand(kind, {
          ...command,
          actorUserId: input.actor.userId,
        });
        const replay = await findCommandReplay(transaction, command.commandId);
        if (replay !== undefined) {
          assertExactAdminReplay(
            replay,
            kind,
            command,
            input.actor.userId,
            fingerprint,
          );
          return {
            claim: await hydrateReplay(transaction, replay),
            status: "DEDUPLICATED",
          };
        }
        if (current.revision !== command.expectedRevision)
          return { status: "STALE_REVISION" };
        const targetState = reviewTargetState(kind);
        if (!validTransition(current.state, targetState))
          return { status: "INVALID_TRANSITION" };
        if (
          kind === "APPROVE" &&
          current.evidenceRequirement === "REQUIRED" &&
          !(await hasReadyEvidence(transaction, current.id))
        ) {
          return { status: "REQUIRED_EVIDENCE_MISSING" };
        }
        const auditEventId = deriveAuditEventId(command.commandId);
        const reasonCategory =
          "reasonCategory" in command ? command.reasonCategory : null;
        const reason = "reason" in command ? command.reason : null;
        await insertCommand(transaction, {
          actorPrivilegedSessionHash: input.privilegedSessionIdHash,
          actorUserId: input.actor.userId,
          auditEventId,
          claimId: current.id,
          commandId: command.commandId,
          commandKind: kind,
          craftsmanProfileId: current.craftsmanProfileId,
          expectedRevision: command.expectedRevision,
          fingerprint,
          reason,
          reasonCategory,
        });
        await transaction`
          UPDATE credential_claims SET
            state = ${targetState}, latest_command_id = ${command.commandId},
            reviewed_by_user_id = ${input.actor.userId}
          WHERE id = ${current.id}
        `;
        await transaction`
          INSERT INTO credential_claim_decisions (
            command_id, claim_id, from_state, to_state, revision,
            actor_user_id, reason_category, reason
          ) VALUES (
            ${command.commandId}, ${current.id}, ${current.state}, ${targetState},
            ${command.expectedRevision + 1}, ${input.actor.userId}, ${reasonCategory}, ${reason}
          )
        `;
        await insertCurrentRevision(transaction, current.id);
        await createAuditRepository(transaction).append({
          action: credentialAuditAction(kind),
          actor: auditActorFromPrivilegedActor(
            input.actor,
            "admin.credentials.review",
          ),
          category: "PRIVILEGED_COMMAND",
          changes: {
            credential_state: { after: targetState, before: current.state },
          },
          correlationId: command.commandId,
          eventId: auditEventId,
          reason: reason ?? "Credential claim approved after manual review.",
          target: { id: current.id, type: "CREDENTIAL_CLAIM" },
        });
        return {
          claim: await getCurrentClaim(transaction, current.id),
          status: "APPLIED",
        };
      });
    },
  });
}

export function createCredentialReviewService(input: {
  readonly adminAccess: AdminAccessService;
  readonly repository: CredentialClaimRepository;
}): CredentialReviewService {
  return Object.freeze({
    async listPending(request: {
      readonly actorUserId: UserId;
      readonly privilegedSessionId: string;
    }): Promise<
      readonly CredentialClaim[] | { readonly status: "AUTHORIZATION_DENIED" }
    > {
      const actor = await authorize(input.adminAccess, request);
      if (actor === undefined)
        return { status: "AUTHORIZATION_DENIED" } as const;
      return input.repository.listPendingAuthorized({
        actor,
        privilegedSessionIdHash: digest(request.privilegedSessionId),
      });
    },
    async review(request: {
      readonly actorUserId: UserId;
      readonly privilegedSessionId: string;
      readonly command: CredentialReviewCommand;
    }): Promise<CredentialReviewServiceResult> {
      const actor = await authorize(input.adminAccess, request);
      if (actor === undefined)
        return { status: "AUTHORIZATION_DENIED" } as const;
      return input.repository.reviewAuthorized({
        actor,
        command: request.command,
        privilegedSessionIdHash: digest(request.privilegedSessionId),
      });
    },
  });
}

async function authorize(
  service: AdminAccessService,
  input: { readonly actorUserId: UserId; readonly privilegedSessionId: string },
): Promise<PrivilegedActor | undefined> {
  if (
    input.privilegedSessionId.length < 16 ||
    input.privilegedSessionId.length > 512
  )
    return undefined;
  const result = await service.authorize({
    capability: "admin.credentials.review",
    requireRecentMfa: true,
    sessionId: input.privilegedSessionId,
    userId: input.actorUserId,
  });
  return result.status === "AUTHORIZED" ? result.actor : undefined;
}

async function lockOwnedActiveProfile(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
): Promise<boolean> {
  const [row] = await sql<{ readonly ownerUserId: string }[]>`
    SELECT profile.owner_user_id AS "ownerUserId"
    FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId} AND profile.owner_user_id = ${input.actorUserId}
      AND owner.account_state = 'ACTIVE'
    FOR UPDATE OF profile, owner
  `;
  return row !== undefined;
}

async function professionAvailable(
  sql: TransactionSql,
  input: CreateCredentialClaimInput,
): Promise<boolean> {
  const [row] = await sql<{ readonly id: string }[]>`
    SELECT id FROM craftsman_professions
    WHERE id = ${input.craftsmanProfessionId}
      AND craftsman_profile_id = ${input.craftsmanProfileId} AND state = 'ACTIVE'
    FOR KEY SHARE
  `;
  return row !== undefined;
}

async function typeAvailable(
  sql: TransactionSql,
  code: string,
): Promise<boolean> {
  const [row] = await sql<{ readonly code: string }[]>`
    SELECT code FROM credential_type_policies WHERE code = ${code} AND active = true FOR KEY SHARE
  `;
  return row !== undefined;
}

async function lockClaim(
  sql: TransactionSql,
  claimId: CredentialClaimId,
  profileId: CraftsmanProfileId,
) {
  const [row] = await sql<CredentialClaimRow[]>`
    SELECT claim.id, claim.craftsman_profile_id AS "craftsmanProfileId",
      claim.craftsman_profession_id AS "craftsmanProfessionId",
      claim.credential_type_code AS "credentialTypeCode",
      claim.evidence_requirement AS "evidenceRequirement",
      claim.expires_on::text AS "expiresOn", claim.state, claim.revision,
      claim.review_reason_category AS "reviewReasonCategory",
      claim.review_reason AS "reviewReason", claim.reviewed_at AS "reviewedAt",
      claim.created_at AS "createdAt", claim.updated_at AS "updatedAt"
    FROM credential_claims claim
    WHERE claim.id = ${claimId} AND claim.craftsman_profile_id = ${profileId} FOR UPDATE
  `;
  return row;
}

async function lockClaimById(sql: TransactionSql, claimId: CredentialClaimId) {
  const [row] = await sql<CredentialClaimRow[]>`
    SELECT claim.id, claim.craftsman_profile_id AS "craftsmanProfileId",
      claim.craftsman_profession_id AS "craftsmanProfessionId",
      claim.credential_type_code AS "credentialTypeCode",
      claim.evidence_requirement AS "evidenceRequirement",
      claim.expires_on::text AS "expiresOn", claim.state, claim.revision,
      claim.review_reason_category AS "reviewReasonCategory",
      claim.review_reason AS "reviewReason", claim.reviewed_at AS "reviewedAt",
      claim.created_at AS "createdAt", claim.updated_at AS "updatedAt"
    FROM credential_claims claim WHERE claim.id = ${claimId} FOR UPDATE
  `;
  return row;
}

async function loadAttachableEvidence(
  sql: TransactionSql,
  input: AttachCredentialEvidenceInput,
) {
  const [row] = await sql<{ readonly mediaKind: "DOCUMENT" | "IMAGE" }[]>`
    SELECT asset.kind AS "mediaKind"
    FROM media_assets asset
    JOIN media_asset_storage_objects object ON object.media_asset_id = asset.id
      AND object.role = 'CANONICAL' AND object.storage_area = 'private'
      AND object.revoked_at IS NULL
    WHERE asset.id = ${input.mediaAssetId} AND asset.owner_user_id = ${input.actorUserId}
      AND asset.status = 'READY' AND asset.kind IN ('DOCUMENT', 'IMAGE')
      AND ((asset.kind = 'DOCUMENT' AND asset.purpose::text = 'CREDENTIAL_DOCUMENT')
        OR (asset.kind = 'IMAGE' AND asset.purpose::text = 'CREDENTIAL_IMAGE'))
      AND asset.provenance_entity_type = 'CREDENTIAL'
      AND asset.provenance_entity_id = ${input.claimId}
      AND asset.provenance_entity_revision = ${input.expectedRevision}
    ORDER BY object.id
    LIMIT 1
    FOR UPDATE OF asset, object
  `;
  return row;
}

async function privilegedSessionValid(
  sql: TransactionSql,
  input: AuthorizedQueueInput,
): Promise<boolean> {
  const [row] = await sql<{ readonly valid: boolean }[]>`
    SELECT true AS valid
    FROM admin_privileged_sessions privileged
    JOIN auth_sessions base ON base.session_id_hash = privileged.session_id_hash
      AND base.user_id = privileged.user_id AND base.revoked_at IS NULL
      AND base.expires_at > clock_timestamp()
    JOIN users actor ON actor.id = privileged.user_id AND actor.account_state = 'ACTIVE'
    JOIN admin_mfa_factors factor ON factor.id = privileged.mfa_factor_id
      AND factor.user_id = privileged.user_id AND factor.revoked_at IS NULL
    JOIN admin_role_grants role ON role.user_id = privileged.user_id
      AND role.revoked_at IS NULL AND role.role IN ('ADMIN', 'SUPER_ADMIN')
    WHERE privileged.session_id_hash = ${input.privilegedSessionIdHash}
      AND privileged.user_id = ${input.actor.userId} AND privileged.revoked_at IS NULL
      AND privileged.expires_at > clock_timestamp()
      AND privileged.mfa_authenticated_at >= clock_timestamp() - interval '15 minutes'
    ORDER BY role.role
    LIMIT 1
    FOR UPDATE OF privileged, base, actor, factor, role
  `;
  return row?.valid === true;
}

async function insertCommand(
  sql: TransactionSql,
  input: {
    readonly actorPrivilegedSessionHash?: string;
    readonly actorUserId: UserId;
    readonly auditEventId?: string;
    readonly claimId: CredentialClaimId;
    readonly commandId: string;
    readonly commandKind: CredentialCommandKind;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly expectedRevision: number;
    readonly fingerprint: string;
    readonly mediaAssetId?: string;
    readonly reason?: string | null;
    readonly reasonCategory?: CredentialReviewReasonCategory | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO credential_claim_commands (
      command_id, command_kind, claim_id, craftsman_profile_id, actor_user_id,
      actor_privileged_session_hash, expected_revision, media_asset_id,
      reason_category, reason, payload_fingerprint, audit_event_id
    ) VALUES (
      ${input.commandId}, ${input.commandKind}, ${input.claimId}, ${input.craftsmanProfileId},
      ${input.actorUserId}, ${input.actorPrivilegedSessionHash ?? null}, ${input.expectedRevision},
      ${input.mediaAssetId ?? null}, ${input.reasonCategory ?? null}, ${input.reason ?? null},
      ${input.fingerprint}, ${input.auditEventId ?? null}
    )
  `;
}

async function insertCurrentRevision(
  sql: TransactionSql,
  claimId: CredentialClaimId,
): Promise<void> {
  await sql`
    INSERT INTO credential_claim_revisions (
      claim_id, revision, command_id, craftsman_profile_id, craftsman_profession_id,
      credential_type_code, evidence_requirement, expires_on, state, evidence_count,
      actor_user_id, reviewed_by_user_id, review_reason_category, review_reason,
      created_at, updated_at, reviewed_at
    ) SELECT claim.id, claim.revision, claim.latest_command_id, claim.craftsman_profile_id,
      claim.craftsman_profession_id, claim.credential_type_code, claim.evidence_requirement,
      claim.expires_on, claim.state,
      (SELECT count(*)::integer FROM credential_claim_evidence evidence WHERE evidence.claim_id = claim.id),
      claim.updated_by_user_id, claim.reviewed_by_user_id, claim.review_reason_category,
      claim.review_reason, claim.created_at, claim.updated_at, claim.reviewed_at
    FROM credential_claims claim WHERE claim.id = ${claimId}
  `;
}

async function findCommandReplay(
  sql: TransactionSql,
  commandId: string,
): Promise<CommandRow | undefined> {
  const [row] = await sql<CommandRow[]>`
    SELECT revision.claim_id AS id, revision.craftsman_profile_id AS "craftsmanProfileId",
      revision.craftsman_profession_id AS "craftsmanProfessionId",
      revision.credential_type_code AS "credentialTypeCode",
      revision.evidence_requirement AS "evidenceRequirement", revision.expires_on::text AS "expiresOn",
      revision.state, revision.revision, revision.review_reason_category AS "reviewReasonCategory",
      revision.review_reason AS "reviewReason", revision.reviewed_at AS "reviewedAt",
      revision.created_at AS "createdAt", revision.updated_at AS "updatedAt",
      command.command_kind AS "commandKind", command.craftsman_profile_id AS "commandProfileId",
      command.actor_user_id AS "actorUserId", command.payload_fingerprint AS "payloadFingerprint"
    FROM credential_claim_commands command
    JOIN credential_claim_revisions revision ON revision.command_id = command.command_id
    WHERE command.command_id = ${commandId}
  `;
  return row;
}

async function hydrateReplay(
  sql: TransactionSql,
  row: CommandRow,
): Promise<CredentialClaim> {
  return hydrateClaim(sql, row);
}

async function getCurrentClaim(
  sql: TransactionSql,
  claimId: CredentialClaimId,
): Promise<CredentialClaim> {
  const row = await lockClaimById(sql, claimId);
  if (row === undefined)
    throw new Error("Committed credential claim projection is missing.");
  return hydrateClaim(sql, row);
}

async function hydrateClaims(
  sql: TransactionSql,
  rows: readonly CredentialClaimRow[],
) {
  return Object.freeze(
    await Promise.all(rows.map((row) => hydrateClaim(sql, row))),
  );
}

async function hydrateClaim(
  sql: TransactionSql,
  row: CredentialClaimRow,
): Promise<CredentialClaim> {
  const evidence = await sql<EvidenceRow[]>`
    SELECT media_asset_id AS "mediaAssetId", media_kind AS "mediaKind", attached_at AS "attachedAt"
    FROM credential_claim_evidence WHERE claim_id = ${row.id}
      AND attached_revision <= ${row.revision}
    ORDER BY attached_revision, media_asset_id
  `;
  return Object.freeze({
    createdAt: row.createdAt,
    craftsmanProfessionId:
      row.craftsmanProfessionId as CredentialClaim["craftsmanProfessionId"],
    craftsmanProfileId: row.craftsmanProfileId,
    credentialTypeCode: row.credentialTypeCode,
    evidence: Object.freeze(evidence.map(freezeEvidence)),
    evidenceRequirement: row.evidenceRequirement,
    expiresOn: row.expiresOn,
    id: row.id,
    reviewReason: row.reviewReason,
    reviewReasonCategory: row.reviewReasonCategory,
    reviewedAt: row.reviewedAt,
    revision: row.revision,
    state: row.state,
    updatedAt: row.updatedAt,
  });
}

function freezeEvidence(row: EvidenceRow): CredentialEvidenceReference {
  return Object.freeze({ ...row });
}

async function hasReadyEvidence(
  sql: TransactionSql,
  claimId: CredentialClaimId,
): Promise<boolean> {
  const [row] = await sql<{ readonly present: boolean }[]>`
    SELECT true AS present FROM credential_claim_evidence evidence
    JOIN media_assets asset ON asset.id = evidence.media_asset_id
    JOIN credential_claims claim ON claim.id = evidence.claim_id
    JOIN media_asset_storage_objects object ON object.media_asset_id = asset.id
      AND object.role = 'CANONICAL' AND object.storage_area = 'private' AND object.revoked_at IS NULL
    WHERE evidence.claim_id = ${claimId} AND asset.status = 'READY'
      AND asset.owner_user_id = claim.created_by_user_id
      AND asset.provenance_entity_type = 'CREDENTIAL'
      AND asset.provenance_entity_id = claim.id
      AND ((asset.kind = 'DOCUMENT' AND asset.purpose::text = 'CREDENTIAL_DOCUMENT')
        OR (asset.kind = 'IMAGE' AND asset.purpose::text = 'CREDENTIAL_IMAGE'))
    ORDER BY evidence.attached_revision, object.id
    LIMIT 1
    FOR UPDATE OF asset, object
  `;
  return row?.present === true;
}

function assertExactOwnerReplay(
  row: CommandRow,
  kind: "CREATE" | "ATTACH_EVIDENCE",
  input: CreateCredentialClaimInput | AttachCredentialEvidenceInput,
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.id !== input.claimId ||
    row.commandProfileId !== input.craftsmanProfileId ||
    row.actorUserId !== input.actorUserId ||
    row.payloadFingerprint !== fingerprint
  )
    throw new CredentialClaimIdempotencyError(
      "Credential claim command idempotency conflict.",
    );
}

function assertExactAdminReplay(
  row: CommandRow,
  kind: "APPROVE" | "REJECT" | "REVOKE",
  input: CredentialReviewCommand,
  actorUserId: UserId,
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.id !== input.claimId ||
    row.actorUserId !== actorUserId ||
    row.payloadFingerprint !== fingerprint
  )
    throw new CredentialClaimIdempotencyError(
      "Credential review command idempotency conflict.",
    );
}

function fingerprintCommand(
  kind: CredentialCommandKind,
  input: object,
): string {
  const value = input as Record<string, unknown>;
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        value.commandId,
        value.claimId,
        value.craftsmanProfileId ?? null,
        value.actorUserId,
        value.expectedRevision ?? 0,
        value.craftsmanProfessionId ?? null,
        value.credentialTypeCode ?? null,
        value.expiresOn ?? null,
        value.mediaAssetId ?? null,
        value.decision ?? null,
        value.reasonCategory ?? null,
        value.reason ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}

function reviewTargetState(
  kind: "APPROVE" | "REJECT" | "REVOKE",
): CredentialClaimState {
  return kind === "APPROVE"
    ? "APPROVED"
    : kind === "REJECT"
      ? "REJECTED"
      : "REVOKED";
}

function credentialAuditAction(kind: "APPROVE" | "REJECT" | "REVOKE"): string {
  return kind === "APPROVE"
    ? "admin.credential.approved"
    : kind === "REJECT"
      ? "admin.credential.rejected"
      : "admin.credential.revoked";
}

function validTransition(
  from: CredentialClaimState,
  to: CredentialClaimState,
): boolean {
  return (
    (from === "PENDING" && (to === "APPROVED" || to === "REJECTED")) ||
    (from === "APPROVED" && to === "REVOKED")
  );
}

function assertAuthorizedActor(actor: PrivilegedActor): void {
  if (!actor.capabilities.has("admin.credentials.review")) {
    throw new Error("Credential review capability is required.");
  }
}

function assertEvidenceUploadPreparationInput(input: {
  readonly actorUserId: UserId;
  readonly claimId: CredentialClaimId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
  readonly mediaKind: "DOCUMENT" | "IMAGE";
}): void {
  assertCredentialClaimListInput({
    actorUserId: input.actorUserId,
    craftsmanProfileId: input.craftsmanProfileId,
  });
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.claimId,
    ) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    (input.mediaKind !== "DOCUMENT" && input.mediaKind !== "IMAGE")
  ) {
    throw new TypeError(
      "Invalid credential evidence upload preparation input.",
    );
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deriveAuditEventId(commandId: string): string {
  const hex = createHash("sha256")
    .update(`credential-audit:${commandId}`, "utf8")
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
