import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfileId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import {
  asStorageObjectKey,
  type PortfolioPublicationCommandInput,
  type StoredPortfolioPublicDerivative,
} from "@portal/media";
import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createPortfolioPublicationRepository,
  createPublicPortfolioDeliveryRepository,
} from "../src/portfolio-publication-repository.js";

interface FixtureRow {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly photoSetRevision: number;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly projectRevision: number;
}

interface SourceRow {
  readonly attachmentId: string;
  readonly byteSize: number;
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly contentSha256: string;
  readonly displayOrder: number;
  readonly mediaAssetId: string;
  readonly phase: "AFTER" | "BEFORE" | "OTHER" | "PROGRESS";
  readonly sourceObjectId: string;
}

/** Runs after the portfolio-photo helper has created a current private photo set. */
export async function runPortfolioPublicationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [fixture] = await sql<FixtureRow[]>`
    SELECT project.author_user_id AS "actorUserId",
      project.craftsman_profile_id AS "craftsmanProfileId",
      project.id AS "portfolioProjectId", project.revision AS "projectRevision",
      photo_set.revision AS "photoSetRevision"
    FROM portfolio_projects project
    JOIN portfolio_project_photo_sets photo_set
      ON photo_set.portfolio_project_id = project.id
    WHERE project.record_state = 'DRAFT'
      AND EXISTS (
        SELECT 1
        FROM portfolio_photo_revisions revision
        JOIN portfolio_photo_revision_items item
          ON item.revision_event_id = revision.event_id
        WHERE revision.portfolio_project_id = project.id
          AND revision.revision = photo_set.revision
          AND item.state = 'ACTIVE'
      )
    ORDER BY photo_set.revision DESC
    LIMIT 1
  `;
  if (fixture === undefined) {
    throw new Error("Expected a private portfolio-photo fixture.");
  }
  await sql.begin(async (transaction) => {
    await transaction`
      SELECT id FROM users WHERE id = ${fixture.actorUserId} FOR UPDATE
    `;
    await transaction`
      UPDATE users SET account_state = 'ACTIVE',
        account_state_changed_at = changed.at, updated_at = changed.at
      FROM (SELECT clock_timestamp() AS at) changed
      WHERE users.id = ${fixture.actorUserId}
    `;
  });

  await sql`
    INSERT INTO media_asset_storage_objects (
      media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256
    )
    SELECT DISTINCT item.media_asset_id,
      'THUMBNAIL'::media_storage_role, 'private'::media_storage_area,
      'private/2026/09/' || gen_random_uuid()::text, 'image/webp',
      canonical.byte_size, canonical.content_sha256
    FROM portfolio_photo_revisions revision
    JOIN portfolio_photo_revision_items item
      ON item.revision_event_id = revision.event_id
    JOIN media_asset_storage_objects canonical
      ON canonical.media_asset_id = item.media_asset_id
      AND canonical.role = 'CANONICAL' AND canonical.revoked_at IS NULL
    WHERE revision.portfolio_project_id = ${fixture.portfolioProjectId}
      AND revision.revision = ${fixture.photoSetRevision}
      AND item.state = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM media_asset_storage_objects existing
        WHERE existing.media_asset_id = item.media_asset_id
          AND existing.role = 'THUMBNAIL' AND existing.revoked_at IS NULL
      )
  `;

  const sources = await loadSources(sql, fixture);
  expect(sources.length).toBeGreaterThan(0);
  const repository = createPortfolioPublicationRepository(sql);
  const publish = publicationCommand(fixture, 0);
  const firstDerivatives = derivatives(sources);
  await expect(
    repository.finalizePublish({
      command: publish,
      derivatives: firstDerivatives,
    }),
  ).resolves.toMatchObject({
    snapshot: { publicationRevision: 1, state: "PUBLIC" },
    status: "APPLIED",
  });
  await expect(repository.preparePublish(publish)).resolves.toMatchObject({
    snapshot: { publicationRevision: 1, state: "PUBLIC" },
    status: "DEDUPLICATED",
  });

  const delivery = createPublicPortfolioDeliveryRepository(sql);
  const firstDelivery = await delivery.loadPublicPortfolioDerivative(
    sources[0]!.mediaAssetId,
  );
  expect(firstDelivery).toMatchObject({
    assetId: sources[0]!.mediaAssetId,
    publicationRevision: "1",
    publicationState: "HIDDEN",
    revokedAt: null,
  });
  expect(firstDelivery?.url.protocol).toBe("https:");

  await runRawSqlNegatives(sql, fixture, firstDerivatives[0]!);

  const hide = publicationCommand(fixture, 1);
  const hidden = await repository.hide(hide);
  expect(hidden).toMatchObject({
    snapshot: { publicationRevision: 2, state: "HIDDEN" },
    status: "APPLIED",
  });
  if (hidden.status !== "APPLIED") throw new Error("Expected hidden result.");
  expect(hidden.pendingRevocations).toHaveLength(sources.length);
  for (const pending of hidden.pendingRevocations) {
    await expect(
      repository.markPublicDerivativeRevoked({
        objectId: pending.objectId,
        publicationRevision: pending.publicationRevision,
      }),
    ).resolves.toBe("REVOKED");
  }

  const republish = publicationCommand(fixture, 2);
  await expect(
    repository.finalizePublish({
      command: republish,
      derivatives: derivatives(sources),
    }),
  ).resolves.toMatchObject({
    snapshot: { publicationRevision: 3, state: "PUBLIC" },
    status: "APPLIED",
  });

  await sql.begin(async (transaction) => {
    await transaction`
      SELECT id FROM users WHERE id = ${fixture.actorUserId} FOR UPDATE
    `;
    await transaction`
      UPDATE users SET account_state = 'SUSPENDED',
        account_state_changed_at = changed.at, updated_at = changed.at
      FROM (SELECT clock_timestamp() AS at) changed
      WHERE users.id = ${fixture.actorUserId}
    `;
  });
  await expect(repository.preparePublish(republish)).resolves.toEqual({
    status: "PROJECT_UNAVAILABLE",
  });
}

async function loadSources(
  sql: Sql,
  fixture: FixtureRow,
): Promise<readonly SourceRow[]> {
  return sql<SourceRow[]>`
    SELECT item.attachment_id AS "attachmentId",
      item.media_asset_id AS "mediaAssetId", item.phase,
      item.display_order AS "displayOrder",
      item.canonical_width AS "canonicalWidth",
      item.canonical_height AS "canonicalHeight",
      source.id AS "sourceObjectId", source.byte_size::integer AS "byteSize",
      source.content_sha256 AS "contentSha256"
    FROM portfolio_photo_revisions revision
    JOIN portfolio_photo_revision_items item
      ON item.revision_event_id = revision.event_id
    JOIN media_asset_storage_objects source
      ON source.media_asset_id = item.media_asset_id
      AND source.role = 'THUMBNAIL' AND source.revoked_at IS NULL
    WHERE revision.portfolio_project_id = ${fixture.portfolioProjectId}
      AND revision.revision = ${fixture.photoSetRevision}
      AND item.state = 'ACTIVE'
    ORDER BY item.display_order
  `;
}

function publicationCommand(
  fixture: FixtureRow,
  expectedPublicationRevision: number,
): PortfolioPublicationCommandInput {
  return {
    actorUserId: fixture.actorUserId,
    commandId: randomUUID(),
    craftsmanProfileId: fixture.craftsmanProfileId,
    expectedPhotoSetRevision: fixture.photoSetRevision,
    expectedProjectRevision: fixture.projectRevision,
    expectedPublicationRevision,
    portfolioProjectId: fixture.portfolioProjectId,
  };
}

function derivatives(
  sources: readonly SourceRow[],
): readonly StoredPortfolioPublicDerivative[] {
  return sources.map((source) => {
    const publicObjectId = randomUUID();
    return Object.freeze({
      ...source,
      publicObject: Object.freeze({
        area: "public-derivative" as const,
        key: asStorageObjectKey(`public-derivative/2026/09/${publicObjectId}`),
      }),
      publicObjectId,
      publicUrl: new URL(`https://media.example.test/${publicObjectId}`),
    });
  });
}

async function runRawSqlNegatives(
  sql: Sql,
  fixture: FixtureRow,
  derivative: StoredPortfolioPublicDerivative,
): Promise<void> {
  await expect(
    sql`
      UPDATE media_asset_storage_objects
      SET storage_key = ${`public-derivative/2026/09/${randomUUID()}`}
      WHERE id = ${derivative.publicObjectId}
    `,
  ).rejects.toThrow(/identity is immutable/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_project_publication_items (
          revision_event_id, attachment_id, media_asset_id, source_object_id,
          public_object_id, phase, display_order, canonical_width,
          canonical_height
        ) VALUES (${derivative.publicObjectId}, ${randomUUID()},
          ${derivative.mediaAssetId}, ${derivative.sourceObjectId},
          ${randomUUID()}, 'OTHER', 1, 1, 1)
      `;
    }),
  ).rejects.toThrow();

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_project_publication_commands (
          command_id, command_kind, portfolio_project_id, craftsman_profile_id,
          actor_user_id, expected_revision, resulting_revision,
          project_revision, photo_set_revision, resulting_state,
          payload_fingerprint
        ) VALUES (${randomUUID()}, 'HIDE', ${fixture.portfolioProjectId},
          ${fixture.craftsmanProfileId}, ${fixture.actorUserId}, 1, 2,
          ${fixture.projectRevision}, ${fixture.photoSetRevision}, 'HIDDEN',
          ${"b".repeat(64)})
      `;
    }),
  ).rejects.toThrow(/command requires exact effect/u);

  const orphanAssetId = randomUUID();
  await sql`
    INSERT INTO media_assets (
      id, owner_user_id, uploaded_by_user_id, kind, purpose, status,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision
    ) VALUES (${orphanAssetId}, ${fixture.actorUserId}, ${fixture.actorUserId},
      'IMAGE', 'PORTFOLIO_IMAGE', 'PROCESSING', 'image/jpeg', 10,
      'PORTFOLIO_PROJECT', ${fixture.portfolioProjectId},
      ${fixture.projectRevision})
  `;
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO media_asset_storage_objects (
          media_asset_id, role, storage_area, storage_key, content_type,
          byte_size, content_sha256, public_url
        ) VALUES (${orphanAssetId}, 'DETAIL', 'public-derivative',
          ${`public-derivative/2026/09/${randomUUID()}`}, 'image/webp', 10,
          ${"c".repeat(64)}, 'https://media.example.test/orphan')
      `;
    }),
  ).rejects.toThrow(/requires publication provenance/u);
}
