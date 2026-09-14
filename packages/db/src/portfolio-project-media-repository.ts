import { createHash } from "node:crypto";

import {
  assertAttachPortfolioProjectPhotoInput,
  assertHidePortfolioProjectPhotoInput,
  assertListPortfolioProjectPhotosInput,
  assertReorderPortfolioProjectPhotosInput,
  assertRestorePortfolioProjectPhotoInput,
  assertSetPortfolioProjectPhotoPhaseInput,
  PORTFOLIO_PROJECT_MAX_PHOTOS,
  type AttachPortfolioProjectPhotoInput,
  type CraftsmanProfileId,
  type HidePortfolioProjectPhotoInput,
  type ListPortfolioProjectPhotosInput,
  type PortfolioPhotoCommandResult,
  type PortfolioPhotoPhase,
  type PortfolioProjectId,
  type PortfolioProjectPhoto,
  type PortfolioProjectPhotoAttachmentId,
  type PortfolioProjectPhotoPersistence,
  type PortfolioProjectPhotoSet,
  type ReorderPortfolioProjectPhotosInput,
  type RestorePortfolioProjectPhotoInput,
  type SetPortfolioProjectPhotoPhaseInput,
  type UserId,
} from "@portal/domain";
import {
  createServerMediaProvenance,
  createServerMediaEntityAccess,
  type MediaEntityAccessResolver,
  type PrivateMediaDeliverySnapshot,
} from "@portal/media";
import type { ServerMediaProvenance } from "@portal/media";
import type { Sql, TransactionSql } from "postgres";

type PhotoCommandKind = "ATTACH" | "REORDER" | "SET_PHASE" | "HIDE" | "RESTORE";

interface OwnedProfileRow {
  readonly accountState: string;
  readonly ownerUserId: UserId;
}

interface LockedPhotoSetRow {
  readonly authorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly projectRecordState: "DRAFT" | "HIDDEN" | "ARCHIVED";
  readonly projectRevision: number;
  readonly revision: number;
}

interface PhotoCommandRow {
  readonly actorUserId: UserId;
  readonly commandKind: PhotoCommandKind;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly payloadFingerprint: string;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly resultingRevision: number;
}

interface PhotoSetItemRow {
  readonly attachedAt: Date | null;
  readonly attachmentId: PortfolioProjectPhotoAttachmentId | null;
  readonly canonicalHeight: number | null;
  readonly canonicalWidth: number | null;
  readonly capturedAt: Date | null;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly displayOrder: number | null;
  readonly mediaAssetId: string | null;
  readonly phase: PortfolioPhotoPhase | null;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly revision: number;
  readonly state: "ACTIVE" | "HIDDEN" | null;
  readonly updatedAt: Date;
}

interface AvailableMediaRow {
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly capturedAt: Date | null;
  readonly id: string;
}

interface CommandTarget {
  readonly attachmentId: PortfolioProjectPhotoAttachmentId | null;
  readonly mediaAssetId: string | null;
  readonly orderedAttachmentIds:
    readonly PortfolioProjectPhotoAttachmentId[] | null;
  readonly phase: PortfolioPhotoPhase | null;
}

export class PortfolioProjectPhotoIdempotencyError extends Error {
  readonly code = "PORTFOLIO_PROJECT_PHOTO_IDEMPOTENCY_CONFLICT";
}

export type PreparePortfolioPhotoUploadResult = Readonly<
  | {
      readonly kind: "IMAGE";
      readonly ownerUserId: UserId;
      readonly provenance: ServerMediaProvenance;
      readonly purpose: "PORTFOLIO_IMAGE";
      readonly status: "AUTHORIZED";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

/**
 * The only R1-014 boundary that mints portfolio upload provenance. Request
 * bodies supply identifiers, never a trusted ServerMediaProvenance marker.
 */
export async function preparePortfolioPhotoUpload(
  sql: Sql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly expectedProjectRevision: number;
    readonly portfolioProjectId: PortfolioProjectId;
  },
): Promise<PreparePortfolioPhotoUploadResult> {
  try {
    assertListPortfolioProjectPhotosInput(input);
  } catch {
    return { status: "UPLOAD_UNAVAILABLE" };
  }
  if (
    !Number.isSafeInteger(input.expectedProjectRevision) ||
    input.expectedProjectRevision < 1
  ) {
    return { status: "UPLOAD_UNAVAILABLE" };
  }
  return sql.begin(async (transaction) => {
    if (!(await lockOwnedActiveProfile(transaction, input))) {
      return { status: "UPLOAD_UNAVAILABLE" } as const;
    }
    const [project] = await transaction<
      Array<{ readonly recordState: string; readonly revision: number }>
    >`
      SELECT record_state AS "recordState", revision
      FROM portfolio_projects
      WHERE id = ${input.portfolioProjectId}
        AND craftsman_profile_id = ${input.craftsmanProfileId}
        AND author_user_id = ${input.actorUserId}
      FOR UPDATE
    `;
    if (
      project === undefined ||
      project.recordState === "ARCHIVED" ||
      project.revision !== input.expectedProjectRevision
    ) {
      return { status: "UPLOAD_UNAVAILABLE" } as const;
    }
    return Object.freeze({
      kind: "IMAGE" as const,
      ownerUserId: input.actorUserId,
      provenance: createServerMediaProvenance({
        entityId: input.portfolioProjectId,
        entityRevision: project.revision,
        entityType: "PORTFOLIO_PROJECT",
      }),
      purpose: "PORTFOLIO_IMAGE" as const,
      status: "AUTHORIZED" as const,
    });
  });
}

export function createPortfolioProjectPhotoRepository(
  sql: Sql,
): PortfolioProjectPhotoPersistence {
  return Object.freeze({
    attach(input: AttachPortfolioProjectPhotoInput) {
      assertAttachPortfolioProjectPhotoInput(input);
      const phase = input.phase ?? "OTHER";
      const fingerprint = fingerprintCommand("ATTACH", { ...input, phase });
      return sql.begin(async (transaction) => {
        const authorized = await beginOwnedCommand(
          transaction,
          input,
          "ATTACH",
          fingerprint,
        );
        if ("result" in authorized) return authorized.result;
        const { photoSet } = authorized;
        if (photoSet.projectRecordState === "ARCHIVED") {
          return { status: "PROJECT_ARCHIVED" } as const;
        }
        if (photoSet.revision !== input.expectedRevision) {
          return { status: "STALE_REVISION" } as const;
        }
        const media = await lockAvailableMedia(
          transaction,
          input.mediaAssetId,
          input.actorUserId,
          input.portfolioProjectId,
          photoSet.projectRevision,
        );
        if (media === undefined)
          return { status: "MEDIA_UNAVAILABLE" } as const;
        const [duplicate] = await transaction<{ readonly id: string }[]>`
          SELECT id FROM portfolio_photo_attachments
          WHERE id = ${input.attachmentId} OR media_asset_id = ${input.mediaAssetId}
        `;
        if (duplicate !== undefined) {
          return { status: "PHOTO_ALREADY_ATTACHED" } as const;
        }
        const currentItems = await loadRevisionItems(
          transaction,
          input.portfolioProjectId,
          photoSet.revision,
        );
        const activeCount = currentItems.filter(
          ({ state }) => state === "ACTIVE",
        ).length;
        if (activeCount >= PORTFOLIO_PROJECT_MAX_PHOTOS) {
          return { status: "PHOTO_LIMIT_REACHED" } as const;
        }
        const nextRevision = photoSet.revision + 1;
        await insertCommand(
          transaction,
          "ATTACH",
          input,
          nextRevision,
          fingerprint,
          {
            attachmentId: input.attachmentId,
            mediaAssetId: input.mediaAssetId,
            orderedAttachmentIds: null,
            phase,
          },
        );
        await transaction`
          INSERT INTO portfolio_photo_attachments (
            id, portfolio_project_id, media_asset_id,
            attached_by_user_id, attach_command_id
          ) VALUES (${input.attachmentId}, ${input.portfolioProjectId},
            ${input.mediaAssetId}, ${input.actorUserId}, ${input.commandId})
        `;
        await advancePhotoSet(transaction, input, nextRevision);
        await insertRevisionHeader(transaction, input, nextRevision);
        await copyPriorItems(
          transaction,
          input.portfolioProjectId,
          photoSet.revision,
          input.commandId,
        );
        await transaction`
          INSERT INTO portfolio_photo_revision_items (
            revision_event_id, attachment_id, media_asset_id, state, phase,
            display_order, captured_at, canonical_width, canonical_height
          ) VALUES (${input.commandId}, ${input.attachmentId}, ${media.id},
            'ACTIVE', ${phase}, ${activeCount + 1}, ${media.capturedAt},
            ${media.canonicalWidth}, ${media.canonicalHeight})
        `;
        return applied(transaction, input.portfolioProjectId, nextRevision);
      });
    },

    reorder(input: ReorderPortfolioProjectPhotosInput) {
      assertReorderPortfolioProjectPhotosInput(input);
      return mutateExisting(sql, "REORDER", input, {
        attachmentId: null,
        mediaAssetId: null,
        orderedAttachmentIds: input.orderedAttachmentIds,
        phase: null,
      });
    },

    setPhase(input: SetPortfolioProjectPhotoPhaseInput) {
      assertSetPortfolioProjectPhotoPhaseInput(input);
      return mutateExisting(sql, "SET_PHASE", input, {
        attachmentId: input.attachmentId,
        mediaAssetId: null,
        orderedAttachmentIds: null,
        phase: input.phase,
      });
    },

    hide(input: HidePortfolioProjectPhotoInput) {
      assertHidePortfolioProjectPhotoInput(input);
      return mutateExisting(sql, "HIDE", input, {
        attachmentId: input.attachmentId,
        mediaAssetId: null,
        orderedAttachmentIds: null,
        phase: null,
      });
    },

    restore(input: RestorePortfolioProjectPhotoInput) {
      assertRestorePortfolioProjectPhotoInput(input);
      return mutateExisting(sql, "RESTORE", input, {
        attachmentId: input.attachmentId,
        mediaAssetId: null,
        orderedAttachmentIds: null,
        phase: null,
      });
    },

    async listOwned(input: ListPortfolioProjectPhotosInput) {
      assertListPortfolioProjectPhotosInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) return null;
        const photoSet = await lockOwnedPhotoSet(transaction, input);
        if (photoSet === undefined) return null;
        return loadPhotoSet(
          transaction,
          input.portfolioProjectId,
          photoSet.revision,
        );
      });
    },
  });
}

export function createPortfolioMediaEntityAccessResolver(
  sql: Sql,
): MediaEntityAccessResolver {
  return Object.freeze({
    async resolvePrivateMediaAccess(snapshot: PrivateMediaDeliverySnapshot) {
      if (
        snapshot.asset.purpose !== "PORTFOLIO_IMAGE" ||
        snapshot.asset.provenanceEntityType !== "PORTFOLIO_PROJECT" ||
        snapshot.asset.provenanceEntityId === null ||
        snapshot.asset.provenanceEntityRevision === null
      ) {
        return createServerMediaEntityAccess({ revision: "portfolio:denied" });
      }
      const [relation] = await sql<{ readonly revision: number }[]>`
        SELECT photo_set.revision
        FROM portfolio_projects project
        JOIN portfolio_project_photo_sets photo_set
          ON photo_set.portfolio_project_id = project.id
        JOIN portfolio_photo_revisions revision
          ON revision.portfolio_project_id = photo_set.portfolio_project_id
          AND revision.revision = photo_set.revision
        JOIN portfolio_photo_revision_items item
          ON item.revision_event_id = revision.event_id
        WHERE project.id = ${snapshot.asset.provenanceEntityId}
          AND project.author_user_id = ${snapshot.actor.userId}
          AND project.author_user_id = ${snapshot.asset.ownerUserId}
          AND item.media_asset_id = ${snapshot.asset.id}
          AND item.state = 'ACTIVE'
          AND EXISTS (
            SELECT 1 FROM portfolio_project_revisions project_revision
            WHERE project_revision.portfolio_project_id = project.id
              AND project_revision.revision = ${snapshot.asset.provenanceEntityRevision}
          )
        LIMIT 1
      `;
      return createServerMediaEntityAccess({
        grants: relation === undefined ? [] : ["PORTFOLIO_PROJECT_OWNER"],
        revision:
          relation === undefined
            ? "portfolio:denied"
            : `portfolio:${snapshot.asset.provenanceEntityId}:${relation.revision}`,
      });
    },
  });
}

async function mutateExisting(
  sql: Sql,
  kind: Exclude<PhotoCommandKind, "ATTACH">,
  input:
    | ReorderPortfolioProjectPhotosInput
    | SetPortfolioProjectPhotoPhaseInput
    | HidePortfolioProjectPhotoInput
    | RestorePortfolioProjectPhotoInput,
  target: CommandTarget,
): Promise<PortfolioPhotoCommandResult> {
  const fingerprint = fingerprintCommand(kind, input);
  return sql.begin(async (transaction) => {
    const authorized = await beginOwnedCommand(
      transaction,
      input,
      kind,
      fingerprint,
    );
    if ("result" in authorized) return authorized.result;
    const { photoSet } = authorized;
    if (photoSet.projectRecordState === "ARCHIVED") {
      return { status: "PROJECT_ARCHIVED" } as const;
    }
    if (photoSet.revision !== input.expectedRevision) {
      return { status: "STALE_REVISION" } as const;
    }
    const items = await loadRevisionItems(
      transaction,
      input.portfolioProjectId,
      photoSet.revision,
    );
    const activeItems = items.filter(({ state }) => state === "ACTIVE");
    const targetItem =
      target.attachmentId === null
        ? undefined
        : items.find(
            ({ attachmentId }) => attachmentId === target.attachmentId,
          );

    if (kind === "REORDER") {
      const ordered = target.orderedAttachmentIds ?? [];
      if (
        ordered.length !== activeItems.length ||
        ordered.some(
          (id) => !activeItems.some(({ attachmentId }) => attachmentId === id),
        )
      ) {
        return { status: "INVALID_ORDER" } as const;
      }
      if (
        activeItems.every((item, index) => item.attachmentId === ordered[index])
      ) {
        return { status: "UNCHANGED" } as const;
      }
    } else if (targetItem === undefined) {
      return { status: "PHOTO_UNAVAILABLE" } as const;
    } else if (
      (kind === "HIDE" && targetItem.state === "HIDDEN") ||
      (kind === "RESTORE" && targetItem.state === "ACTIVE") ||
      (kind === "SET_PHASE" && targetItem.phase === target.phase)
    ) {
      return { status: "UNCHANGED" } as const;
    } else if (
      kind === "RESTORE" &&
      activeItems.length >= PORTFOLIO_PROJECT_MAX_PHOTOS
    ) {
      return { status: "PHOTO_LIMIT_REACHED" } as const;
    }

    const nextRevision = photoSet.revision + 1;
    await insertCommand(
      transaction,
      kind,
      input,
      nextRevision,
      fingerprint,
      target,
    );
    await advancePhotoSet(transaction, input, nextRevision);
    await insertRevisionHeader(transaction, input, nextRevision);
    await insertTransformedItems(
      transaction,
      kind,
      input.portfolioProjectId,
      input.commandId,
      photoSet.revision,
      target,
      activeItems.length,
      targetItem?.order ?? null,
    );
    return applied(transaction, input.portfolioProjectId, nextRevision);
  });
}

async function beginOwnedCommand(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly portfolioProjectId: PortfolioProjectId;
  },
  kind: PhotoCommandKind,
  fingerprint: string,
): Promise<
  | { readonly photoSet: LockedPhotoSetRow }
  | { readonly result: PortfolioPhotoCommandResult }
> {
  if (!(await lockOwnedActiveProfile(transaction, input))) {
    return { result: { status: "PROFILE_UNAVAILABLE" } };
  }
  const replay = await findCommand(transaction, input.commandId);
  if (replay !== undefined) {
    assertExactReplay(replay, kind, input, fingerprint);
    return {
      result: {
        photoSet: await loadPhotoSet(
          transaction,
          replay.portfolioProjectId,
          replay.resultingRevision,
        ),
        status: "DEDUPLICATED",
      },
    };
  }
  const photoSet = await lockOwnedPhotoSet(transaction, input);
  return photoSet === undefined
    ? { result: { status: "PROJECT_UNAVAILABLE" } }
    : { photoSet };
}

async function lockOwnedActiveProfile(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
): Promise<boolean> {
  const [row] = await transaction<OwnedProfileRow[]>`
    SELECT profile.owner_user_id AS "ownerUserId", owner.account_state AS "accountState"
    FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId}
    FOR UPDATE OF profile, owner
  `;
  return (
    row?.ownerUserId === input.actorUserId && row.accountState === "ACTIVE"
  );
}

async function lockOwnedPhotoSet(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly portfolioProjectId: PortfolioProjectId;
  },
): Promise<LockedPhotoSetRow | undefined> {
  const [project] = await transaction<
    Array<Omit<LockedPhotoSetRow, "revision">>
  >`
    SELECT project.id AS "portfolioProjectId",
      project.craftsman_profile_id AS "craftsmanProfileId",
      project.author_user_id AS "authorUserId",
      project.record_state AS "projectRecordState",
      project.revision AS "projectRevision"
    FROM portfolio_projects project
    WHERE project.id = ${input.portfolioProjectId}
      AND project.craftsman_profile_id = ${input.craftsmanProfileId}
      AND project.author_user_id = ${input.actorUserId}
    FOR UPDATE OF project
  `;
  if (project === undefined) return undefined;
  const [photoSet] = await transaction<{ readonly revision: number }[]>`
    SELECT revision FROM portfolio_project_photo_sets
    WHERE portfolio_project_id = ${input.portfolioProjectId}
      AND craftsman_profile_id = ${input.craftsmanProfileId}
    FOR UPDATE
  `;
  return photoSet === undefined
    ? undefined
    : Object.freeze({ ...project, revision: photoSet.revision });
}

async function lockAvailableMedia(
  transaction: TransactionSql,
  mediaAssetId: string,
  actorUserId: UserId,
  projectId: PortfolioProjectId,
  projectRevision: number,
): Promise<AvailableMediaRow | undefined> {
  const [row] = await transaction<AvailableMediaRow[]>`
    SELECT asset.id, asset.captured_at AS "capturedAt",
      asset.canonical_width AS "canonicalWidth",
      asset.canonical_height AS "canonicalHeight"
    FROM media_assets asset
    JOIN media_asset_storage_objects object
      ON object.media_asset_id = asset.id AND object.role = 'CANONICAL'
      AND object.storage_area = 'private' AND object.revoked_at IS NULL
      AND object.content_type = 'image/webp'
    WHERE asset.id = ${mediaAssetId}
      AND asset.owner_user_id = ${actorUserId}
      AND asset.uploaded_by_user_id = ${actorUserId}
      AND asset.kind = 'IMAGE' AND asset.purpose = 'PORTFOLIO_IMAGE'
      AND asset.status = 'READY'
      AND asset.provenance_entity_type = 'PORTFOLIO_PROJECT'
      AND asset.provenance_entity_id = ${projectId}
      AND asset.provenance_entity_revision BETWEEN 1 AND ${projectRevision}
      AND EXISTS (
        SELECT 1 FROM portfolio_project_revisions revision
        WHERE revision.portfolio_project_id = ${projectId}
          AND revision.revision = asset.provenance_entity_revision
      )
    FOR UPDATE OF asset, object
  `;
  return row;
}

async function findCommand(
  transaction: TransactionSql,
  commandId: string,
): Promise<PhotoCommandRow | undefined> {
  const [row] = await transaction<PhotoCommandRow[]>`
    SELECT command_kind AS "commandKind", portfolio_project_id AS "portfolioProjectId",
      craftsman_profile_id AS "craftsmanProfileId", actor_user_id AS "actorUserId",
      resulting_revision AS "resultingRevision", payload_fingerprint AS "payloadFingerprint"
    FROM portfolio_photo_commands WHERE command_id = ${commandId}
  `;
  return row;
}

function assertExactReplay(
  row: PhotoCommandRow,
  kind: PhotoCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly portfolioProjectId: PortfolioProjectId;
  },
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.actorUserId !== input.actorUserId ||
    row.craftsmanProfileId !== input.craftsmanProfileId ||
    row.portfolioProjectId !== input.portfolioProjectId ||
    row.payloadFingerprint !== fingerprint
  ) {
    throw new PortfolioProjectPhotoIdempotencyError(
      "Portfolio photo command id was reused with different intent.",
    );
  }
}

async function insertCommand(
  transaction: TransactionSql,
  kind: PhotoCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly expectedRevision: number;
    readonly portfolioProjectId: PortfolioProjectId;
  },
  resultingRevision: number,
  fingerprint: string,
  target: CommandTarget,
): Promise<void> {
  await transaction`
    INSERT INTO portfolio_photo_commands (
      command_id, command_kind, portfolio_project_id, craftsman_profile_id,
      actor_user_id, expected_revision, resulting_revision,
      target_attachment_id, target_media_asset_id, target_phase,
      ordered_attachment_ids, payload_fingerprint
    ) VALUES (${input.commandId}, ${kind}, ${input.portfolioProjectId},
      ${input.craftsmanProfileId}, ${input.actorUserId}, ${input.expectedRevision},
      ${resultingRevision}, ${target.attachmentId}, ${target.mediaAssetId},
      ${target.phase}, ${target.orderedAttachmentIds}, ${fingerprint})
  `;
}

async function advancePhotoSet(
  transaction: TransactionSql,
  input: {
    readonly commandId: string;
    readonly portfolioProjectId: PortfolioProjectId;
  },
  nextRevision: number,
): Promise<void> {
  await transaction`
    UPDATE portfolio_project_photo_sets SET revision = ${nextRevision},
      latest_command_id = ${input.commandId}
    WHERE portfolio_project_id = ${input.portfolioProjectId}
  `;
}

async function insertRevisionHeader(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly portfolioProjectId: PortfolioProjectId;
  },
  revision: number,
): Promise<void> {
  await transaction`
    INSERT INTO portfolio_photo_revisions (
      event_id, command_id, portfolio_project_id, revision, actor_user_id
    ) VALUES (${input.commandId}, ${input.commandId}, ${input.portfolioProjectId},
      ${revision}, ${input.actorUserId})
  `;
}

async function copyPriorItems(
  transaction: TransactionSql,
  projectId: PortfolioProjectId,
  priorRevision: number,
  eventId: string,
): Promise<void> {
  await transaction`
    INSERT INTO portfolio_photo_revision_items (
      revision_event_id, attachment_id, media_asset_id, state, phase,
      display_order, captured_at, canonical_width, canonical_height
    ) SELECT ${eventId}, item.attachment_id, item.media_asset_id, item.state,
      item.phase, item.display_order, item.captured_at,
      item.canonical_width, item.canonical_height
    FROM portfolio_photo_revisions revision
    JOIN portfolio_photo_revision_items item ON item.revision_event_id = revision.event_id
    WHERE revision.portfolio_project_id = ${projectId}
      AND revision.revision = ${priorRevision}
  `;
}

async function insertTransformedItems(
  transaction: TransactionSql,
  kind: Exclude<PhotoCommandKind, "ATTACH">,
  projectId: PortfolioProjectId,
  eventId: string,
  priorRevision: number,
  target: CommandTarget,
  activeCount: number,
  targetPriorOrder: number | null,
): Promise<void> {
  await transaction`
    INSERT INTO portfolio_photo_revision_items (
      revision_event_id, attachment_id, media_asset_id, state, phase,
      display_order, captured_at, canonical_width, canonical_height
    ) SELECT ${eventId}, item.attachment_id, item.media_asset_id,
      CASE
        WHEN ${kind} = 'HIDE' AND item.attachment_id = ${target.attachmentId} THEN 'HIDDEN'::portfolio_photo_state
        WHEN ${kind} = 'RESTORE' AND item.attachment_id = ${target.attachmentId} THEN 'ACTIVE'::portfolio_photo_state
        ELSE item.state
      END,
      CASE WHEN ${kind} = 'SET_PHASE' AND item.attachment_id = ${target.attachmentId}
        THEN ${target.phase}::portfolio_photo_phase ELSE item.phase END,
      CASE
        WHEN ${kind} = 'REORDER' AND item.state = 'ACTIVE'
          THEN array_position(${target.orderedAttachmentIds}::uuid[], item.attachment_id)
        WHEN ${kind} = 'HIDE' AND item.attachment_id = ${target.attachmentId} THEN NULL
        WHEN ${kind} = 'HIDE' AND item.state = 'ACTIVE'
          AND item.display_order > ${targetPriorOrder} THEN item.display_order - 1
        WHEN ${kind} = 'RESTORE' AND item.attachment_id = ${target.attachmentId}
          THEN ${activeCount + 1}
        ELSE item.display_order
      END,
      item.captured_at, item.canonical_width, item.canonical_height
    FROM portfolio_photo_revisions revision
    JOIN portfolio_photo_revision_items item ON item.revision_event_id = revision.event_id
    WHERE revision.portfolio_project_id = ${projectId}
      AND revision.revision = ${priorRevision}
  `;
}

async function loadRevisionItems(
  sql: TransactionSql,
  projectId: PortfolioProjectId,
  revision: number,
): Promise<readonly PortfolioProjectPhoto[]> {
  if (revision === 0) return [];
  const rows = await sql<
    Array<{
      readonly attachedAt: Date;
      readonly attachmentId: PortfolioProjectPhotoAttachmentId;
      readonly canonicalHeight: number;
      readonly canonicalWidth: number;
      readonly capturedAt: Date | null;
      readonly displayOrder: number | null;
      readonly mediaAssetId: string;
      readonly phase: PortfolioPhotoPhase;
      readonly state: "ACTIVE" | "HIDDEN";
    }>
  >`
    SELECT item.attachment_id AS "attachmentId", item.media_asset_id AS "mediaAssetId",
      item.state, item.phase, item.display_order AS "displayOrder",
      item.captured_at AS "capturedAt", item.canonical_width AS "canonicalWidth",
      item.canonical_height AS "canonicalHeight", attachment.attached_at AS "attachedAt"
    FROM portfolio_photo_revisions revision
    JOIN portfolio_photo_revision_items item ON item.revision_event_id = revision.event_id
    JOIN portfolio_photo_attachments attachment ON attachment.id = item.attachment_id
    WHERE revision.portfolio_project_id = ${projectId} AND revision.revision = ${revision}
    ORDER BY CASE WHEN item.state = 'ACTIVE' THEN 0 ELSE 1 END,
      item.display_order NULLS LAST, attachment.attached_at, attachment.id
  `;
  return rows.map(freezePhoto);
}

async function loadPhotoSet(
  sql: TransactionSql,
  projectId: PortfolioProjectId,
  revision: number,
): Promise<PortfolioProjectPhotoSet> {
  const [header] = await sql<PhotoSetItemRow[]>`
    SELECT photo_set.portfolio_project_id AS "portfolioProjectId",
      photo_set.craftsman_profile_id AS "craftsmanProfileId", ${revision}::integer AS revision,
      CASE WHEN ${revision} = 0 THEN photo_set.updated_at ELSE event.occurred_at END AS "updatedAt",
      NULL::uuid AS "attachmentId", NULL::uuid AS "mediaAssetId",
      NULL::portfolio_photo_state AS state, NULL::portfolio_photo_phase AS phase,
      NULL::integer AS "displayOrder", NULL::timestamptz AS "capturedAt",
      NULL::integer AS "canonicalWidth", NULL::integer AS "canonicalHeight",
      NULL::timestamptz AS "attachedAt"
    FROM portfolio_project_photo_sets photo_set
    LEFT JOIN portfolio_photo_revisions event
      ON event.portfolio_project_id = photo_set.portfolio_project_id
      AND event.revision = ${revision}
    WHERE photo_set.portfolio_project_id = ${projectId}
      AND (${revision} = 0 OR event.event_id IS NOT NULL)
  `;
  if (header === undefined)
    throw new Error("Committed portfolio photo revision is missing.");
  return Object.freeze({
    craftsmanProfileId: header.craftsmanProfileId,
    photos: Object.freeze([
      ...(await loadRevisionItems(sql, projectId, revision)),
    ]),
    portfolioProjectId: header.portfolioProjectId,
    revision: header.revision,
    updatedAt: header.updatedAt,
  });
}

async function applied(
  transaction: TransactionSql,
  projectId: PortfolioProjectId,
  revision: number,
): Promise<PortfolioPhotoCommandResult> {
  return {
    photoSet: await loadPhotoSet(transaction, projectId, revision),
    status: "APPLIED",
  };
}

function freezePhoto(row: {
  readonly attachedAt: Date;
  readonly attachmentId: PortfolioProjectPhotoAttachmentId;
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly capturedAt: Date | null;
  readonly displayOrder: number | null;
  readonly mediaAssetId: string;
  readonly phase: PortfolioPhotoPhase;
  readonly state: "ACTIVE" | "HIDDEN";
}): PortfolioProjectPhoto {
  return Object.freeze({
    attachedAt: row.attachedAt,
    attachmentId: row.attachmentId,
    canonicalHeight: row.canonicalHeight,
    canonicalWidth: row.canonicalWidth,
    capturedAt: row.capturedAt,
    mediaAssetId: row.mediaAssetId,
    order: row.displayOrder,
    phase: row.phase,
    state: row.state,
  });
}

function fingerprintCommand(kind: PhotoCommandKind, input: object): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, input]), "utf8")
    .digest("hex");
}
