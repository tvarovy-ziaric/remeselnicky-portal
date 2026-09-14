import { createHash } from "node:crypto";

import type {
  CraftsmanProfileId,
  PortfolioPhotoPhase,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import {
  asStorageObjectKey,
  assertPortfolioPublicationCommand,
  type ApplyPortfolioPublicationResult,
  type PendingPublicDerivativeRevocation,
  type PortfolioPublicationCommandInput,
  type PortfolioPublicationRepository,
  type PortfolioPublicationSnapshot,
  type PreparedPortfolioPublicationPhoto,
  type PublicPortfolioDeliveryRepository,
  type PublicPortfolioDerivativeSnapshot,
  type StoredPortfolioPublicDerivative,
} from "@portal/media";
import type { Sql, TransactionSql } from "postgres";

interface PublicationHeadRow {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly publicationRevision: number;
  readonly state: "HIDDEN" | "PUBLIC";
}

interface ProjectRow {
  readonly authorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly projectRevision: number;
  readonly provenanceKind: "SELF_DECLARED";
  readonly recordState: "ARCHIVED" | "DRAFT" | "HIDDEN";
}

interface PhotoSetRow {
  readonly photoSetRevision: number;
}

interface SourcePhotoRow {
  readonly attachmentId: string;
  readonly byteSize: number;
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly contentSha256: string;
  readonly displayOrder: number;
  readonly mediaAssetId: string;
  readonly phase: PortfolioPhotoPhase;
  readonly sourceObjectId: string;
  readonly storageArea: "private";
  readonly storageKey: string;
}

interface CommandRow {
  readonly actorUserId: UserId;
  readonly commandKind: "HIDE" | "PUBLISH";
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
  readonly payloadFingerprint: string;
  readonly photoSetRevision: number;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly projectRevision: number;
  readonly resultingRevision: number;
  readonly resultingState: "HIDDEN" | "PUBLIC";
}

interface PendingRevocationRow {
  readonly objectId: string;
  readonly storageArea: "public-derivative";
  readonly storageKey: string;
}

interface PublicDerivativeRow {
  readonly assetId: string;
  readonly assetStatus: PublicPortfolioDerivativeSnapshot["assetStatus"];
  readonly contentType: string;
  readonly objectId: string;
  readonly publicUrl: string;
  readonly publicationRevision: number;
  readonly publicationState: "HIDDEN" | "PUBLIC";
  readonly purpose: PublicPortfolioDerivativeSnapshot["purpose"];
  readonly revokedAt: Date | null;
  readonly role: "DETAIL" | "THUMBNAIL";
  readonly storageArea: "public-derivative";
  readonly storageKey: string;
}

type SourceLockFailure = Readonly<{
  readonly status:
    | "PROJECT_UNAVAILABLE"
    | "STALE_PHOTO_SET_REVISION"
    | "STALE_PROJECT_REVISION"
    | "STALE_PUBLICATION_REVISION";
}>;

export class PortfolioPublicationIdempotencyError extends Error {
  readonly code = "PORTFOLIO_PUBLICATION_IDEMPOTENCY_CONFLICT";
}

export function createPortfolioPublicationRepository(
  sql: Sql,
): PortfolioPublicationRepository {
  return Object.freeze({
    preparePublish(command: PortfolioPublicationCommandInput) {
      assertPortfolioPublicationCommand(command);
      const fingerprint = fingerprintCommand("PUBLISH", command);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, command))) {
          return { status: "PROJECT_UNAVAILABLE" } as const;
        }
        const replay = await findCommand(transaction, command.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "PUBLISH", command, fingerprint);
          return {
            snapshot: snapshotFromCommand(replay),
            status: "DEDUPLICATED",
          } as const;
        }
        const current = await lockPublicationSources(
          transaction,
          command,
          true,
        );
        if ("status" in current) return current;
        const photos = await loadSourcePhotos(transaction, command);
        if (photos.length < 1 || photos.length > 15) {
          return { status: "PHOTO_SET_UNAVAILABLE" } as const;
        }
        return Object.freeze({ photos, status: "READY" as const });
      });
    },

    finalizePublish(input: {
      readonly command: PortfolioPublicationCommandInput;
      readonly derivatives: readonly StoredPortfolioPublicDerivative[];
    }) {
      assertPortfolioPublicationCommand(input.command);
      assertStoredDerivatives(input.derivatives);
      const fingerprint = fingerprintCommand("PUBLISH", input.command);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input.command))) {
          return { status: "PROJECT_UNAVAILABLE" } as const;
        }
        const replay = await findCommand(transaction, input.command.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "PUBLISH", input.command, fingerprint);
          return {
            snapshot: snapshotFromCommand(replay),
            status: "DEDUPLICATED",
          } as const;
        }
        const current = await lockPublicationSources(
          transaction,
          input.command,
          true,
        );
        if ("status" in current) return current;
        const photos = await loadSourcePhotos(transaction, input.command);
        if (!sameDerivativeSet(photos, input.derivatives)) {
          return { status: "PHOTO_SET_UNAVAILABLE" } as const;
        }
        return applyPublish(
          transaction,
          input.command,
          input.derivatives,
          fingerprint,
        );
      });
    },

    hide(command: PortfolioPublicationCommandInput) {
      assertPortfolioPublicationCommand(command);
      const fingerprint = fingerprintCommand("HIDE", command);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, command))) {
          return { status: "PROJECT_UNAVAILABLE" } as const;
        }
        const replay = await findCommand(transaction, command.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "HIDE", command, fingerprint);
          return {
            pendingRevocations: await loadPendingRevocations(
              transaction,
              replay.portfolioProjectId,
              replay.expectedRevision,
              replay.resultingRevision,
            ),
            snapshot: snapshotFromCommand(replay),
            status: "DEDUPLICATED",
          } as const;
        }
        const current = await lockPublicationSources(
          transaction,
          command,
          false,
        );
        if ("status" in current) return current;
        if (current.publication.state !== "PUBLIC") {
          return { status: "PUBLICATION_ALREADY_HIDDEN" } as const;
        }
        const resultingRevision = command.expectedPublicationRevision + 1;
        await insertCommand(transaction, "HIDE", command, fingerprint);
        await transaction`
          INSERT INTO portfolio_project_publication_revisions (
            event_id, command_id, portfolio_project_id, revision, state,
            project_revision, photo_set_revision, actor_user_id
          ) VALUES (
            ${command.commandId}, ${command.commandId},
            ${command.portfolioProjectId}, ${resultingRevision}, 'HIDDEN',
            ${command.expectedProjectRevision},
            ${command.expectedPhotoSetRevision}, ${command.actorUserId}
          )
        `;
        await updateHead(transaction, command, resultingRevision, "HIDDEN");
        return Object.freeze({
          pendingRevocations: await loadPendingRevocations(
            transaction,
            command.portfolioProjectId,
            command.expectedPublicationRevision,
            resultingRevision,
          ),
          snapshot: Object.freeze({
            photoSetRevision: command.expectedPhotoSetRevision,
            projectRevision: command.expectedProjectRevision,
            publicationRevision: resultingRevision,
            state: "HIDDEN" as const,
          }),
          status: "APPLIED" as const,
        });
      });
    },

    async markPublicDerivativeRevoked(input: {
      readonly objectId: string;
      readonly publicationRevision: number;
    }) {
      assertUuid(input.objectId, "objectId");
      assertNonnegativeRevision(
        input.publicationRevision,
        "publicationRevision",
      );
      const rows = await sql`
        UPDATE media_asset_storage_objects object
        SET revoked_at = clock_timestamp()
        WHERE object.id = ${input.objectId}
          AND object.storage_area = 'public-derivative'
          AND object.revoked_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM portfolio_project_publication_items item
            JOIN portfolio_project_publication_revisions revision
              ON revision.event_id = item.revision_event_id
            JOIN portfolio_project_publications publication
              ON publication.portfolio_project_id = revision.portfolio_project_id
            WHERE item.public_object_id = object.id
              AND publication.revision = ${input.publicationRevision}
          )
      `;
      return rows.count === 1 ? "REVOKED" : "STALE";
    },
  });
}

export function createPublicPortfolioDeliveryRepository(
  sql: Sql,
): PublicPortfolioDeliveryRepository {
  return Object.freeze({
    async loadPublicPortfolioDerivative(mediaAssetId: string) {
      assertUuid(mediaAssetId, "mediaAssetId");
      const [row] = await sql<PublicDerivativeRow[]>`
        SELECT asset.id AS "assetId", asset.status AS "assetStatus",
          asset.purpose, object.id AS "objectId", object.role,
          object.storage_area AS "storageArea", object.storage_key AS "storageKey",
          object.content_type AS "contentType", object.public_url AS "publicUrl",
          object.revoked_at AS "revokedAt",
          publication.revision AS "publicationRevision",
          CASE WHEN public_project.portfolio_project_id IS NOT NULL
            THEN 'PUBLIC' ELSE 'HIDDEN' END AS "publicationState"
        FROM portfolio_project_publications publication
        JOIN LATERAL (
          SELECT revision.*
          FROM portfolio_project_publication_revisions revision
          WHERE revision.portfolio_project_id = publication.portfolio_project_id
            AND revision.state = 'PUBLIC'
          ORDER BY revision.revision DESC
          LIMIT 1
        ) published_revision ON true
        JOIN portfolio_project_publication_items item
          ON item.revision_event_id = published_revision.event_id
        JOIN media_assets asset ON asset.id = item.media_asset_id
        JOIN media_asset_storage_objects object
          ON object.id = item.public_object_id
        LEFT JOIN current_public_portfolio_projects public_project
          ON public_project.portfolio_project_id = publication.portfolio_project_id
          AND public_project.publication_revision = publication.revision
        WHERE item.media_asset_id = ${mediaAssetId}
        ORDER BY published_revision.revision DESC
        LIMIT 1
      `;
      if (row === undefined) return null;
      try {
        return publicDerivative(row);
      } catch {
        return null;
      }
    },

    markPublicDerivativeRevoked(input: {
      readonly objectId: string;
      readonly publicationRevision: string;
    }) {
      return createPortfolioPublicationRepository(
        sql,
      ).markPublicDerivativeRevoked({
        objectId: input.objectId,
        publicationRevision: Number(input.publicationRevision),
      });
    },
  });
}

async function lockOwnedActiveProfile(
  sql: TransactionSql,
  input: PortfolioPublicationCommandInput,
): Promise<boolean> {
  const [row] = await sql<{ readonly ownerUserId: UserId }[]>`
    SELECT profile.owner_user_id AS "ownerUserId"
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId}
      AND owner.account_state = 'ACTIVE'
    FOR UPDATE OF profile, owner
  `;
  return row?.ownerUserId === input.actorUserId;
}

async function lockPublicationSources(
  sql: TransactionSql,
  input: PortfolioPublicationCommandInput,
  requirePublishEligible: boolean,
): Promise<
  | {
      readonly photoSet: PhotoSetRow;
      readonly project: ProjectRow;
      readonly publication: PublicationHeadRow;
    }
  | SourceLockFailure
> {
  const [project] = await sql<ProjectRow[]>`
    SELECT craftsman_profile_id AS "craftsmanProfileId",
      author_user_id AS "authorUserId", revision AS "projectRevision",
      provenance_kind AS "provenanceKind", record_state AS "recordState"
    FROM portfolio_projects
    WHERE id = ${input.portfolioProjectId}
    FOR UPDATE
  `;
  if (
    project === undefined ||
    project.craftsmanProfileId !== input.craftsmanProfileId ||
    project.authorUserId !== input.actorUserId ||
    (requirePublishEligible &&
      (project.recordState !== "DRAFT" ||
        project.provenanceKind !== "SELF_DECLARED"))
  ) {
    return { status: "PROJECT_UNAVAILABLE" };
  }
  const [photoSet] = await sql<PhotoSetRow[]>`
    SELECT revision AS "photoSetRevision"
    FROM portfolio_project_photo_sets
    WHERE portfolio_project_id = ${input.portfolioProjectId}
      AND craftsman_profile_id = ${input.craftsmanProfileId}
    FOR UPDATE
  `;
  const [publication] = await sql<PublicationHeadRow[]>`
    SELECT craftsman_profile_id AS "craftsmanProfileId",
      revision AS "publicationRevision", state
    FROM portfolio_project_publications
    WHERE portfolio_project_id = ${input.portfolioProjectId}
      AND craftsman_profile_id = ${input.craftsmanProfileId}
    FOR UPDATE
  `;
  if (photoSet === undefined || publication === undefined) {
    return { status: "PROJECT_UNAVAILABLE" };
  }
  if (project.projectRevision !== input.expectedProjectRevision) {
    return { status: "STALE_PROJECT_REVISION" };
  }
  if (photoSet.photoSetRevision !== input.expectedPhotoSetRevision) {
    return { status: "STALE_PHOTO_SET_REVISION" };
  }
  if (publication.publicationRevision !== input.expectedPublicationRevision) {
    return { status: "STALE_PUBLICATION_REVISION" };
  }
  return { photoSet, project, publication };
}

async function loadSourcePhotos(
  sql: TransactionSql,
  input: PortfolioPublicationCommandInput,
): Promise<readonly PreparedPortfolioPublicationPhoto[]> {
  const rows = await sql<SourcePhotoRow[]>`
    SELECT item.attachment_id AS "attachmentId",
      item.media_asset_id AS "mediaAssetId", item.phase,
      item.display_order AS "displayOrder",
      item.canonical_width AS "canonicalWidth",
      item.canonical_height AS "canonicalHeight",
      source.id AS "sourceObjectId", source.storage_area AS "storageArea",
      source.storage_key AS "storageKey", source.byte_size::integer AS "byteSize",
      source.content_sha256 AS "contentSha256"
    FROM portfolio_photo_revisions revision
    JOIN portfolio_photo_revision_items item
      ON item.revision_event_id = revision.event_id
    JOIN portfolio_photo_attachments attachment
      ON attachment.id = item.attachment_id
    JOIN media_assets asset ON asset.id = item.media_asset_id
    JOIN media_asset_storage_objects source
      ON source.media_asset_id = asset.id
      AND source.role = 'THUMBNAIL' AND source.storage_area = 'private'
      AND source.revoked_at IS NULL
    WHERE revision.portfolio_project_id = ${input.portfolioProjectId}
      AND revision.revision = ${input.expectedPhotoSetRevision}
      AND item.state = 'ACTIVE'
      AND asset.status = 'READY' AND asset.kind = 'IMAGE'
      AND asset.purpose = 'PORTFOLIO_IMAGE'
      AND asset.owner_user_id = ${input.actorUserId}
      AND asset.provenance_entity_type = 'PORTFOLIO_PROJECT'
      AND asset.provenance_entity_id = ${input.portfolioProjectId}
      AND source.content_type = 'image/webp'
      AND source.content_sha256 IS NOT NULL
    ORDER BY item.display_order
    FOR UPDATE OF attachment, asset, source
  `;
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        attachmentId: row.attachmentId,
        byteSize: row.byteSize,
        canonicalHeight: row.canonicalHeight,
        canonicalWidth: row.canonicalWidth,
        contentSha256: row.contentSha256,
        displayOrder: row.displayOrder,
        mediaAssetId: row.mediaAssetId,
        phase: row.phase,
        sourceObject: Object.freeze({
          area: row.storageArea,
          key: asStorageObjectKey(row.storageKey),
        }),
        sourceObjectId: row.sourceObjectId,
      }),
    ),
  );
}

async function applyPublish(
  sql: TransactionSql,
  command: PortfolioPublicationCommandInput,
  derivatives: readonly StoredPortfolioPublicDerivative[],
  fingerprint: string,
): Promise<ApplyPortfolioPublicationResult> {
  const resultingRevision = command.expectedPublicationRevision + 1;
  await insertCommand(sql, "PUBLISH", command, fingerprint);
  for (const derivative of derivatives) {
    await sql`
      INSERT INTO media_asset_storage_objects (
        id, media_asset_id, role, storage_area, storage_key, content_type,
        byte_size, content_sha256, public_url
      ) VALUES (
        ${derivative.publicObjectId}, ${derivative.mediaAssetId}, 'DETAIL',
        'public-derivative', ${derivative.publicObject.key}, 'image/webp',
        ${derivative.byteSize}, ${derivative.contentSha256},
        ${derivative.publicUrl.toString()}
      )
    `;
  }
  await sql`
    INSERT INTO portfolio_project_publication_revisions (
      event_id, command_id, portfolio_project_id, revision, state,
      project_revision, photo_set_revision, actor_user_id
    ) VALUES (
      ${command.commandId}, ${command.commandId}, ${command.portfolioProjectId},
      ${resultingRevision}, 'PUBLIC', ${command.expectedProjectRevision},
      ${command.expectedPhotoSetRevision}, ${command.actorUserId}
    )
  `;
  for (const derivative of derivatives) {
    await sql`
      INSERT INTO portfolio_project_publication_items (
        revision_event_id, attachment_id, media_asset_id, source_object_id,
        public_object_id, phase, display_order, canonical_width, canonical_height
      ) VALUES (
        ${command.commandId}, ${derivative.attachmentId},
        ${derivative.mediaAssetId}, ${derivative.sourceObjectId},
        ${derivative.publicObjectId}, ${derivative.phase},
        ${derivative.displayOrder}, ${derivative.canonicalWidth},
        ${derivative.canonicalHeight}
      )
    `;
  }
  await updateHead(sql, command, resultingRevision, "PUBLIC");
  return Object.freeze({
    snapshot: Object.freeze({
      photoSetRevision: command.expectedPhotoSetRevision,
      projectRevision: command.expectedProjectRevision,
      publicationRevision: resultingRevision,
      state: "PUBLIC" as const,
    }),
    status: "APPLIED" as const,
  });
}

async function insertCommand(
  sql: TransactionSql,
  kind: "HIDE" | "PUBLISH",
  command: PortfolioPublicationCommandInput,
  fingerprint: string,
): Promise<void> {
  await sql`
    INSERT INTO portfolio_project_publication_commands (
      command_id, command_kind, portfolio_project_id, craftsman_profile_id,
      actor_user_id, expected_revision, resulting_revision, project_revision,
      photo_set_revision, resulting_state, payload_fingerprint
    ) VALUES (
      ${command.commandId}, ${kind}, ${command.portfolioProjectId},
      ${command.craftsmanProfileId}, ${command.actorUserId},
      ${command.expectedPublicationRevision},
      ${command.expectedPublicationRevision + 1},
      ${command.expectedProjectRevision}, ${command.expectedPhotoSetRevision},
      ${kind === "PUBLISH" ? "PUBLIC" : "HIDDEN"}, ${fingerprint}
    )
  `;
}

async function updateHead(
  sql: TransactionSql,
  command: PortfolioPublicationCommandInput,
  revision: number,
  state: "HIDDEN" | "PUBLIC",
): Promise<void> {
  await sql`
    UPDATE portfolio_project_publications
    SET revision = ${revision}, state = ${state},
      latest_command_id = ${command.commandId}, updated_at = clock_timestamp()
    WHERE portfolio_project_id = ${command.portfolioProjectId}
      AND revision = ${command.expectedPublicationRevision}
  `;
}

async function findCommand(
  sql: TransactionSql,
  commandId: string,
): Promise<CommandRow | undefined> {
  const [row] = await sql<CommandRow[]>`
    SELECT command_kind AS "commandKind",
      portfolio_project_id AS "portfolioProjectId",
      craftsman_profile_id AS "craftsmanProfileId",
      actor_user_id AS "actorUserId", expected_revision AS "expectedRevision",
      resulting_revision AS "resultingRevision",
      project_revision AS "projectRevision",
      photo_set_revision AS "photoSetRevision",
      resulting_state AS "resultingState",
      payload_fingerprint AS "payloadFingerprint"
    FROM portfolio_project_publication_commands
    WHERE command_id = ${commandId}
  `;
  return row;
}

function assertExactReplay(
  row: CommandRow,
  kind: "HIDE" | "PUBLISH",
  input: PortfolioPublicationCommandInput,
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.portfolioProjectId !== input.portfolioProjectId ||
    row.craftsmanProfileId !== input.craftsmanProfileId ||
    row.actorUserId !== input.actorUserId ||
    row.expectedRevision !== input.expectedPublicationRevision ||
    row.projectRevision !== input.expectedProjectRevision ||
    row.photoSetRevision !== input.expectedPhotoSetRevision ||
    row.payloadFingerprint !== fingerprint
  ) {
    throw new PortfolioPublicationIdempotencyError(
      "Portfolio publication command id was reused with different intent.",
    );
  }
}

function snapshotFromCommand(row: CommandRow): PortfolioPublicationSnapshot {
  return Object.freeze({
    photoSetRevision: row.photoSetRevision,
    projectRevision: row.projectRevision,
    publicationRevision: row.resultingRevision,
    state: row.resultingState,
  });
}

async function loadPendingRevocations(
  sql: TransactionSql,
  projectId: PortfolioProjectId,
  sourcePublicationRevision: number,
  currentPublicationRevision: number,
): Promise<readonly PendingPublicDerivativeRevocation[]> {
  const rows = await sql<PendingRevocationRow[]>`
    SELECT object.id AS "objectId", object.storage_area AS "storageArea",
      object.storage_key AS "storageKey"
    FROM portfolio_project_publication_revisions revision
    JOIN portfolio_project_publication_items item
      ON item.revision_event_id = revision.event_id
    JOIN media_asset_storage_objects object
      ON object.id = item.public_object_id
    WHERE revision.portfolio_project_id = ${projectId}
      AND revision.revision = ${sourcePublicationRevision}
      AND object.revoked_at IS NULL
    ORDER BY item.display_order
  `;
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        objectId: row.objectId,
        publicationRevision: currentPublicationRevision,
        storageObject: Object.freeze({
          area: row.storageArea,
          key: asStorageObjectKey(row.storageKey),
        }),
      }),
    ),
  );
}

function sameDerivativeSet(
  photos: readonly PreparedPortfolioPublicationPhoto[],
  derivatives: readonly StoredPortfolioPublicDerivative[],
): boolean {
  return (
    photos.length === derivatives.length &&
    photos.every((photo, index) => {
      const derivative = derivatives[index];
      return (
        derivative !== undefined &&
        derivative.attachmentId === photo.attachmentId &&
        derivative.mediaAssetId === photo.mediaAssetId &&
        derivative.sourceObjectId === photo.sourceObjectId &&
        derivative.byteSize === photo.byteSize &&
        derivative.contentSha256 === photo.contentSha256 &&
        derivative.phase === photo.phase &&
        derivative.displayOrder === photo.displayOrder &&
        derivative.canonicalWidth === photo.canonicalWidth &&
        derivative.canonicalHeight === photo.canonicalHeight &&
        derivative.publicObject.area === "public-derivative"
      );
    })
  );
}

function assertStoredDerivatives(
  derivatives: readonly StoredPortfolioPublicDerivative[],
): void {
  if (derivatives.length < 1 || derivatives.length > 15) {
    throw new TypeError("One to fifteen public derivatives are required.");
  }
  const attachmentIds = new Set<string>();
  const mediaAssetIds = new Set<string>();
  const publicObjectIds = new Set<string>();
  for (const [index, derivative] of derivatives.entries()) {
    assertUuid(derivative.attachmentId, "attachmentId");
    assertUuid(derivative.mediaAssetId, "mediaAssetId");
    assertUuid(derivative.publicObjectId, "publicObjectId");
    assertUuid(derivative.sourceObjectId, "sourceObjectId");
    if (
      derivative.publicObject.area !== "public-derivative" ||
      derivative.publicUrl.protocol !== "https:" ||
      derivative.publicUrl.username !== "" ||
      derivative.publicUrl.password !== "" ||
      derivative.publicUrl.search !== "" ||
      derivative.publicUrl.hash !== "" ||
      derivative.publicUrl.toString().length > 2048 ||
      !/^[0-9a-f]{64}$/u.test(derivative.contentSha256) ||
      !Number.isSafeInteger(derivative.byteSize) ||
      derivative.byteSize < 1 ||
      !Number.isSafeInteger(derivative.canonicalWidth) ||
      derivative.canonicalWidth < 1 ||
      derivative.canonicalWidth > 12_000 ||
      !Number.isSafeInteger(derivative.canonicalHeight) ||
      derivative.canonicalHeight < 1 ||
      derivative.canonicalHeight > 12_000 ||
      derivative.displayOrder !== index ||
      !["BEFORE", "PROGRESS", "AFTER", "OTHER"].includes(derivative.phase) ||
      attachmentIds.has(derivative.attachmentId) ||
      mediaAssetIds.has(derivative.mediaAssetId) ||
      publicObjectIds.has(derivative.publicObjectId)
    ) {
      throw new TypeError("Stored public derivative is invalid.");
    }
    attachmentIds.add(derivative.attachmentId);
    mediaAssetIds.add(derivative.mediaAssetId);
    publicObjectIds.add(derivative.publicObjectId);
  }
}

function publicDerivative(
  row: PublicDerivativeRow,
): PublicPortfolioDerivativeSnapshot {
  return Object.freeze({
    assetId: row.assetId,
    assetStatus: row.assetStatus,
    contentType: row.contentType,
    objectId: row.objectId,
    publicationRevision: String(row.publicationRevision),
    publicationState: row.publicationState,
    purpose: row.purpose,
    revokedAt: row.revokedAt,
    role: row.role,
    storageObject: Object.freeze({
      area: row.storageArea,
      key: asStorageObjectKey(row.storageKey),
    }),
    url: new URL(row.publicUrl),
  });
}

function fingerprintCommand(
  kind: "HIDE" | "PUBLISH",
  input: PortfolioPublicationCommandInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        input.actorUserId,
        input.commandId,
        input.craftsmanProfileId,
        input.portfolioProjectId,
        input.expectedPublicationRevision,
        input.expectedProjectRevision,
        input.expectedPhotoSetRevision,
      ]),
      "utf8",
    )
    .digest("hex");
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`${field} must be a UUID.`);
  }
}

function assertNonnegativeRevision(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
}
