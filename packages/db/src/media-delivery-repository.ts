import {
  asStorageObjectKey,
  type PrivateMediaDeliveryRepository,
  type PrivateMediaDeliverySnapshot,
} from "@portal/media";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";

interface PrivateMediaDeliveryRow {
  readonly actorAccountState: PrivateMediaDeliverySnapshot["actor"]["accountState"];
  readonly actorUserId: string;
  readonly assetId: string;
  readonly assetStatus: PrivateMediaDeliverySnapshot["asset"]["status"];
  readonly assetUpdatedAt: Date;
  readonly contentType: string;
  readonly objectCreatedAt: Date;
  readonly objectId: string;
  readonly objectRevokedAt: Date | null;
  readonly ownerUserId: string;
  readonly provenanceEntityId: string | null;
  readonly provenanceEntityRevision: number | null;
  readonly provenanceEntityType: PrivateMediaDeliverySnapshot["asset"]["provenanceEntityType"];
  readonly purpose: PrivateMediaDeliverySnapshot["asset"]["purpose"];
  readonly storageArea: PrivateMediaDeliverySnapshot["object"]["storageObject"]["area"];
  readonly storageKey: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Loads the current account, asset and canonical-object projection together.
 * Entity-role grants deliberately remain in feature-owned repositories because
 * invitation, Job, conversation, Quote and dispute schemas arrive later.
 */
export function createPrivateMediaDeliveryRepository(
  sql: Sql,
): PrivateMediaDeliveryRepository {
  return Object.freeze({
    async loadPrivateDeliverySnapshot(input: {
      readonly actorUserId: string;
      readonly mediaAssetId: string;
    }) {
      if (
        !uuidPattern.test(input.actorUserId) ||
        !uuidPattern.test(input.mediaAssetId)
      ) {
        return null;
      }

      const [row] = await sql<PrivateMediaDeliveryRow[]>`
        SELECT
          actor.id AS "actorUserId",
          actor.account_state AS "actorAccountState",
          asset.id AS "assetId",
          asset.owner_user_id AS "ownerUserId",
          asset.status AS "assetStatus",
          asset.purpose,
          asset.provenance_entity_type AS "provenanceEntityType",
          asset.provenance_entity_id AS "provenanceEntityId",
          asset.provenance_entity_revision AS "provenanceEntityRevision",
          asset.updated_at AS "assetUpdatedAt",
          object.id AS "objectId",
          object.storage_area AS "storageArea",
          object.storage_key AS "storageKey",
          object.content_type AS "contentType",
          object.created_at AS "objectCreatedAt",
          object.revoked_at AS "objectRevokedAt"
        FROM users AS actor
        INNER JOIN media_assets AS asset
          ON asset.id = ${input.mediaAssetId}
        INNER JOIN media_asset_storage_objects AS object
          ON object.media_asset_id = asset.id
          AND object.role = 'CANONICAL'
        WHERE actor.id = ${input.actorUserId}
        LIMIT 1
      `;
      if (row === undefined) return null;

      return Object.freeze({
        actor: Object.freeze({
          accountState: row.actorAccountState,
          userId: row.actorUserId as UserId,
        }),
        asset: Object.freeze({
          id: row.assetId,
          ownerUserId: row.ownerUserId as UserId,
          provenanceEntityId: row.provenanceEntityId,
          provenanceEntityRevision: row.provenanceEntityRevision,
          provenanceEntityType: row.provenanceEntityType,
          purpose: row.purpose,
          status: row.assetStatus,
          updatedAt: row.assetUpdatedAt,
        }),
        object: Object.freeze({
          contentType: row.contentType,
          createdAt: row.objectCreatedAt,
          id: row.objectId,
          revokedAt: row.objectRevokedAt,
          role: "CANONICAL" as const,
          storageObject: Object.freeze({
            area: row.storageArea,
            key: asStorageObjectKey(row.storageKey),
          }),
        }),
      });
    },
  });
}
