import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  PortfolioProjectId,
  PortfolioProjectPhotoAttachmentId,
  UserId,
} from "@portal/domain";
import {
  asStorageObjectKey,
  type PrivateMediaDeliverySnapshot,
} from "@portal/media";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import {
  createPortfolioMediaEntityAccessResolver,
  createPortfolioProjectPhotoRepository,
  preparePortfolioPhotoUpload,
} from "../src/portfolio-project-media-repository.js";
import { createPortfolioProjectRepository } from "../src/portfolio-project-repository.js";

/** Runs after the R1-004/R1-006 governed fixture helpers on a clean database. */
export async function runPortfolioProjectMediaIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [taxonomy] = await sql<{ readonly releaseId: string }[]>`
    SELECT release_id AS "releaseId" FROM profession_taxonomy_activation_events
    ORDER BY activation_sequence DESC LIMIT 1
  `;
  const [location] = await sql<
    { readonly districtCode: string; readonly municipalityCode: string }[]
  >`
    SELECT municipality.code AS "municipalityCode",
      municipality.district_code AS "districtCode"
    FROM location_municipalities municipality
    JOIN location_districts district ON district.code = municipality.district_code
    WHERE municipality.is_active AND district.is_active
    ORDER BY municipality.code LIMIT 1
  `;
  if (taxonomy === undefined || location === undefined) {
    throw new Error("Expected governed taxonomy and location fixtures.");
  }

  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [other] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined || other === undefined)
    throw new Error("Expected users.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  const [otherProfile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${other.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined || otherProfile === undefined) {
    throw new Error("Expected profiles.");
  }

  const professions = createCraftsmanProfessionRepository(sql);
  const professionId = randomUUID() as CraftsmanProfessionId;
  await expect(
    professions.assign({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profile.id,
      declaredLevel: "BEGINNER",
      professionCode: "TEST:CAPABILITY_ALPHA",
      taxonomyReleaseId: taxonomy.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const projectId = randomUUID() as PortfolioProjectId;
  const projects = createPortfolioProjectRepository(sql);
  await expect(
    projects.create({
      actorUserId: owner.id,
      commandId: randomUUID(),
      contribution: null,
      craftsmanProfileId: profile.id,
      districtCode: location.districtCode,
      durationUnit: null,
      durationValue: null,
      indicativePriceMaxCents: null,
      indicativePriceMinCents: null,
      materialsAndTechnologies: "Potrubie 1/2 a rozvody 230/400 V",
      municipalityCode: location.municipalityCode,
      portfolioProjectId: projectId,
      problem: null,
      professionIds: [professionId],
      shortDescription: "Súkromná realizácia pripravená na fotografie",
      skillIds: [],
      solution: null,
      specializationIds: [],
      title: "Realizácia s fotodokumentáciou",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  await expect(
    preparePortfolioPhotoUpload(sql, {
      actorUserId: other.id,
      craftsmanProfileId: profile.id,
      expectedProjectRevision: 1,
      portfolioProjectId: projectId,
    }),
  ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
  await expect(
    preparePortfolioPhotoUpload(sql, {
      actorUserId: owner.id,
      craftsmanProfileId: profile.id,
      expectedProjectRevision: 2,
      portfolioProjectId: projectId,
    }),
  ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
  const prepared = await preparePortfolioPhotoUpload(sql, {
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    expectedProjectRevision: 1,
    portfolioProjectId: projectId,
  });
  expect(prepared).toMatchObject({
    kind: "IMAGE",
    provenance: {
      entityId: projectId,
      entityRevision: 1,
      entityType: "PORTFOLIO_PROJECT",
    },
    purpose: "PORTFOLIO_IMAGE",
    status: "AUTHORIZED",
  });

  const primaryAssetId = await insertReadyImage(sql, {
    ownerUserId: owner.id,
    portfolioProjectId: projectId,
    provenanceRevision: 1,
  });
  const secondAssetId = await insertReadyImage(sql, {
    ownerUserId: owner.id,
    portfolioProjectId: projectId,
    provenanceRevision: 1,
  });
  const invalidAssets = await createInvalidAssets(
    sql,
    owner.id,
    other.id,
    projectId,
  );

  const photos = createPortfolioProjectPhotoRepository(sql);
  const primaryAttachmentId = randomUUID() as PortfolioProjectPhotoAttachmentId;
  const primaryAttach = photoCommand({
    actorUserId: owner.id,
    attachmentId: primaryAttachmentId,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 0,
    mediaAssetId: primaryAssetId,
    portfolioProjectId: projectId,
  });
  const attachRace = await Promise.all([
    photos.attach(primaryAttach),
    photos.attach(primaryAttach),
  ]);
  expect(attachRace.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);

  for (const mediaAssetId of invalidAssets) {
    await expect(
      photos.attach(
        photoCommand({
          ...primaryAttach,
          attachmentId: randomUUID() as PortfolioProjectPhotoAttachmentId,
          commandId: randomUUID(),
          expectedRevision: 1,
          mediaAssetId,
        }),
      ),
    ).resolves.toEqual({ status: "MEDIA_UNAVAILABLE" });
  }
  await expect(
    photos.attach({
      ...primaryAttach,
      actorUserId: other.id,
      commandId: randomUUID(),
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });

  const secondAttachmentId = randomUUID() as PortfolioProjectPhotoAttachmentId;
  const second = await photos.attach(
    photoCommand({
      ...primaryAttach,
      attachmentId: secondAttachmentId,
      commandId: randomUUID(),
      expectedRevision: 1,
      mediaAssetId: secondAssetId,
      phase: "BEFORE",
    }),
  );
  expect(second).toMatchObject({ status: "APPLIED" });
  const phased = await photos.setPhase({
    actorUserId: owner.id,
    attachmentId: primaryAttachmentId,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 2,
    phase: "AFTER",
    portfolioProjectId: projectId,
  });
  expect(phased).toMatchObject({ status: "APPLIED" });
  const reordered = await photos.reorder({
    actorUserId: owner.id,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 3,
    orderedAttachmentIds: [secondAttachmentId, primaryAttachmentId],
    portfolioProjectId: projectId,
  });
  expect(reordered).toMatchObject({
    photoSet: {
      photos: [
        { attachmentId: secondAttachmentId, order: 1 },
        { attachmentId: primaryAttachmentId, order: 2 },
      ],
    },
    status: "APPLIED",
  });
  await expect(
    photos.reorder({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      expectedRevision: 4,
      orderedAttachmentIds: [primaryAttachmentId],
      portfolioProjectId: projectId,
    }),
  ).resolves.toEqual({ status: "INVALID_ORDER" });

  const hidden = await photos.hide({
    actorUserId: owner.id,
    attachmentId: primaryAttachmentId,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 4,
    portfolioProjectId: projectId,
  });
  expect(hidden.status).toBe("APPLIED");
  if (hidden.status !== "APPLIED") throw new Error("Expected hidden photo.");
  expect(hidden.photoSet.photos.some(({ state }) => state === "HIDDEN")).toBe(
    true,
  );
  const resolver = createPortfolioMediaEntityAccessResolver(sql);
  expect(
    (
      await resolver.resolvePrivateMediaAccess(
        deliverySnapshot(owner.id, projectId, primaryAssetId),
      )
    ).grants,
  ).toEqual([]);
  const restored = await photos.restore({
    actorUserId: owner.id,
    attachmentId: primaryAttachmentId,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 5,
    portfolioProjectId: projectId,
  });
  expect(restored).toMatchObject({ status: "APPLIED" });
  expect(
    (
      await resolver.resolvePrivateMediaAccess(
        deliverySnapshot(owner.id, projectId, primaryAssetId),
      )
    ).grants,
  ).toEqual(["PORTFOLIO_PROJECT_OWNER"]);

  await expect(photos.attach(primaryAttach)).resolves.toMatchObject({
    photoSet: {
      photos: [
        {
          attachmentId: primaryAttachmentId,
          order: 1,
          phase: "OTHER",
          state: "ACTIVE",
        },
      ],
      revision: 1,
    },
    status: "DEDUPLICATED",
  });

  const rawMetadataAssetId = await insertReadyImage(sql, {
    ownerUserId: owner.id,
    portfolioProjectId: projectId,
    provenanceRevision: 1,
  });
  await runRawSqlPhotoNegatives(sql, {
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    currentRevision: 6,
    metadataAssetId: rawMetadataAssetId,
    portfolioProjectId: projectId,
    primaryAttachmentId,
  });

  await runCanonicalRevokeRace(sql, {
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    currentRevision: 6,
    photos,
    portfolioProjectId: projectId,
  });
  const afterRevokeRace = await photos.listOwned({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    portfolioProjectId: projectId,
  });
  if (afterRevokeRace === null)
    throw new Error("Expected photo set after revoke race.");
  let currentRevision = afterRevokeRace.revision;
  const photosNeededForRace =
    14 -
    afterRevokeRace.photos.filter(({ state }) => state === "ACTIVE").length;
  for (let index = 0; index < photosNeededForRace; index += 1) {
    const assetId = await insertReadyImage(sql, {
      ownerUserId: owner.id,
      portfolioProjectId: projectId,
      provenanceRevision: 1,
    });
    const result = await photos.attach(
      photoCommand({
        ...primaryAttach,
        attachmentId: randomUUID() as PortfolioProjectPhotoAttachmentId,
        commandId: randomUUID(),
        expectedRevision: currentRevision,
        mediaAssetId: assetId,
      }),
    );
    expect(result).toMatchObject({ status: "APPLIED" });
    currentRevision += 1;
  }
  const raceAssets = await Promise.all(
    [0, 1].map(() =>
      insertReadyImage(sql, {
        ownerUserId: owner.id,
        portfolioProjectId: projectId,
        provenanceRevision: 1,
      }),
    ),
  );
  const limitRace = await Promise.all(
    raceAssets.map((mediaAssetId) =>
      photos.attach(
        photoCommand({
          ...primaryAttach,
          attachmentId: randomUUID() as PortfolioProjectPhotoAttachmentId,
          commandId: randomUUID(),
          expectedRevision: currentRevision,
          mediaAssetId,
        }),
      ),
    ),
  );
  expect(limitRace.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);
  currentRevision += 1;
  const full = await photos.listOwned({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    portfolioProjectId: projectId,
  });
  expect(full?.photos.filter(({ state }) => state === "ACTIVE")).toHaveLength(
    15,
  );
  const overflowAsset = await insertReadyImage(sql, {
    ownerUserId: owner.id,
    portfolioProjectId: projectId,
    provenanceRevision: 1,
  });
  await expect(
    photos.attach(
      photoCommand({
        ...primaryAttach,
        attachmentId: randomUUID() as PortfolioProjectPhotoAttachmentId,
        commandId: randomUUID(),
        expectedRevision: currentRevision,
        mediaAssetId: overflowAsset,
      }),
    ),
  ).resolves.toEqual({ status: "PHOTO_LIMIT_REACHED" });
  await expect(
    rawAttachSnapshot(sql, {
      actorUserId: owner.id,
      canonicalHeight: 900,
      canonicalWidth: 1200,
      craftsmanProfileId: profile.id,
      currentRevision,
      mediaAssetId: overflowAsset,
      portfolioProjectId: projectId,
    }),
  ).rejects.toThrow(
    /portfolio_photo_revision_item_state_order|exceeds max 15/u,
  );

  await runSuspensionReplayRace(sql, owner.id, profile.id, projectId, photos, {
    attachmentId: primaryAttachmentId,
    currentRevision,
  });
}

async function runCanonicalRevokeRace(
  sql: Sql,
  fixture: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly currentRevision: number;
    readonly photos: ReturnType<typeof createPortfolioProjectPhotoRepository>;
    readonly portfolioProjectId: PortfolioProjectId;
  },
): Promise<void> {
  const mediaAssetId = await insertReadyImage(sql, {
    ownerUserId: fixture.actorUserId,
    portfolioProjectId: fixture.portfolioProjectId,
    provenanceRevision: 1,
  });
  const [attach] = await Promise.all([
    fixture.photos.attach(
      photoCommand({
        actorUserId: fixture.actorUserId,
        attachmentId: randomUUID() as PortfolioProjectPhotoAttachmentId,
        commandId: randomUUID(),
        craftsmanProfileId: fixture.craftsmanProfileId,
        expectedRevision: fixture.currentRevision,
        mediaAssetId,
        portfolioProjectId: fixture.portfolioProjectId,
      }),
    ),
    sql.begin(async (transaction) => {
      await transaction`
        SELECT id FROM media_asset_storage_objects
        WHERE media_asset_id = ${mediaAssetId} AND role = 'CANONICAL' FOR UPDATE
      `;
      await transaction`
        UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
        WHERE media_asset_id = ${mediaAssetId} AND role = 'CANONICAL'
      `;
    }),
  ]);
  expect(["APPLIED", "MEDIA_UNAVAILABLE"]).toContain(attach.status);
  if (attach.status === "APPLIED") {
    const [ordering] = await sql<
      { readonly attachedAt: Date; readonly revokedAt: Date }[]
    >`
      SELECT attachment.attached_at AS "attachedAt", object.revoked_at AS "revokedAt"
      FROM portfolio_photo_attachments attachment
      JOIN media_asset_storage_objects object
        ON object.media_asset_id = attachment.media_asset_id
        AND object.role = 'CANONICAL'
      WHERE attachment.media_asset_id = ${mediaAssetId}
    `;
    if (ordering === undefined)
      throw new Error("Expected revoke race ordering.");
    expect(ordering.attachedAt.valueOf()).toBeLessThanOrEqual(
      ordering.revokedAt.valueOf(),
    );
  }
}

async function runRawSqlPhotoNegatives(
  sql: Sql,
  fixture: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly currentRevision: number;
    readonly metadataAssetId: string;
    readonly portfolioProjectId: PortfolioProjectId;
    readonly primaryAttachmentId: PortfolioProjectPhotoAttachmentId;
  },
): Promise<void> {
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_photo_attachments (
          id, portfolio_project_id, media_asset_id, attached_by_user_id,
          attach_command_id
        ) VALUES (${randomUUID()}, ${fixture.portfolioProjectId}, ${randomUUID()},
          ${fixture.actorUserId}, ${randomUUID()})
      `;
    }),
  ).rejects.toThrow(/matching command provenance/u);
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        UPDATE portfolio_project_photo_sets SET revision = revision + 1
        WHERE portfolio_project_id = ${fixture.portfolioProjectId}
      `;
    }),
  ).rejects.toThrow(/matching command/u);
  await expect(sql`
    DELETE FROM portfolio_photo_revisions
    WHERE portfolio_project_id = ${fixture.portfolioProjectId}
  `).rejects.toThrow(/append-only/u);

  const [oldRevision] = await sql<{ readonly eventId: string }[]>`
    SELECT event_id AS "eventId" FROM portfolio_photo_revisions
    WHERE portfolio_project_id = ${fixture.portfolioProjectId} AND revision = 1
  `;
  if (oldRevision === undefined)
    throw new Error("Expected sealed photo revision.");
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_photo_revision_items (
          revision_event_id, attachment_id, media_asset_id, state, phase,
          display_order, canonical_width, canonical_height
        ) VALUES (${oldRevision.eventId}, ${randomUUID()}, ${randomUUID()},
          'HIDDEN', 'OTHER', NULL, 1, 1)
      `;
    }),
  ).rejects.toThrow(/sealed with their parent revision/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_photo_commands (
          command_id, command_kind, portfolio_project_id, craftsman_profile_id,
          actor_user_id, expected_revision, resulting_revision,
          target_attachment_id, payload_fingerprint
        ) VALUES (${randomUUID()}, 'HIDE', ${fixture.portfolioProjectId},
          ${fixture.craftsmanProfileId}, ${fixture.actorUserId},
          ${fixture.currentRevision}, ${fixture.currentRevision + 1},
          ${fixture.primaryAttachmentId}, ${"0".repeat(64)})
      `;
    }),
  ).rejects.toThrow(/requires exact set and revision effects/u);
  await expect(
    rawAttachSnapshot(sql, {
      actorUserId: fixture.actorUserId,
      canonicalHeight: 1,
      canonicalWidth: 1,
      craftsmanProfileId: fixture.craftsmanProfileId,
      currentRevision: fixture.currentRevision,
      mediaAssetId: fixture.metadataAssetId,
      portfolioProjectId: fixture.portfolioProjectId,
    }),
  ).rejects.toThrow(/invalid portfolio photo attach effect/u);
  await expect(
    sql`INSERT INTO media_assets (
      owner_user_id, uploaded_by_user_id, kind, purpose,
      declared_content_type, byte_size
    ) VALUES (${fixture.actorUserId}, ${fixture.actorUserId}, 'VIDEO',
      'PORTFOLIO_IMAGE', 'video/mp4', 10)`,
  ).rejects.toThrow(/media_kind/u);
}

async function rawAttachSnapshot(
  sql: Sql,
  input: {
    readonly actorUserId: UserId;
    readonly canonicalHeight: number;
    readonly canonicalWidth: number;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly currentRevision: number;
    readonly mediaAssetId: string;
    readonly portfolioProjectId: PortfolioProjectId;
  },
): Promise<void> {
  const commandId = randomUUID();
  const attachmentId = randomUUID();
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO portfolio_photo_commands (
        command_id, command_kind, portfolio_project_id, craftsman_profile_id,
        actor_user_id, expected_revision, resulting_revision,
        target_attachment_id, target_media_asset_id, target_phase,
        payload_fingerprint
      ) VALUES (${commandId}, 'ATTACH', ${input.portfolioProjectId},
        ${input.craftsmanProfileId}, ${input.actorUserId},
        ${input.currentRevision}, ${input.currentRevision + 1},
        ${attachmentId}, ${input.mediaAssetId}, 'OTHER', ${"b".repeat(64)})
    `;
    await transaction`
      INSERT INTO portfolio_photo_attachments (
        id, portfolio_project_id, media_asset_id, attached_by_user_id,
        attach_command_id
      ) VALUES (${attachmentId}, ${input.portfolioProjectId},
        ${input.mediaAssetId}, ${input.actorUserId}, ${commandId})
    `;
    await transaction`
      UPDATE portfolio_project_photo_sets
      SET revision = ${input.currentRevision + 1}, latest_command_id = ${commandId}
      WHERE portfolio_project_id = ${input.portfolioProjectId}
    `;
    await transaction`
      INSERT INTO portfolio_photo_revisions (
        event_id, command_id, portfolio_project_id, revision, actor_user_id
      ) VALUES (${commandId}, ${commandId}, ${input.portfolioProjectId},
        ${input.currentRevision + 1}, ${input.actorUserId})
    `;
    await transaction`
      INSERT INTO portfolio_photo_revision_items (
        revision_event_id, attachment_id, media_asset_id, state, phase,
        display_order, captured_at, canonical_width, canonical_height
      ) SELECT ${commandId}, item.attachment_id, item.media_asset_id,
        item.state, item.phase, item.display_order, item.captured_at,
        item.canonical_width, item.canonical_height
      FROM portfolio_photo_revisions revision
      JOIN portfolio_photo_revision_items item
        ON item.revision_event_id = revision.event_id
      WHERE revision.portfolio_project_id = ${input.portfolioProjectId}
        AND revision.revision = ${input.currentRevision}
    `;
    const [count] = await transaction<{ readonly activeCount: number }[]>`
      SELECT count(*)::integer AS "activeCount"
      FROM portfolio_photo_revision_items
      WHERE revision_event_id = ${commandId} AND state = 'ACTIVE'
    `;
    if (count === undefined) throw new Error("Expected raw snapshot count.");
    await transaction`
      INSERT INTO portfolio_photo_revision_items (
        revision_event_id, attachment_id, media_asset_id, state, phase,
        display_order, captured_at, canonical_width, canonical_height
      ) VALUES (${commandId}, ${attachmentId}, ${input.mediaAssetId},
        'ACTIVE', 'OTHER', ${count.activeCount + 1}, NULL,
        ${input.canonicalWidth}, ${input.canonicalHeight})
    `;
  });
}

async function runSuspensionReplayRace(
  sql: Sql,
  ownerUserId: UserId,
  craftsmanProfileId: CraftsmanProfileId,
  portfolioProjectId: PortfolioProjectId,
  photos: ReturnType<typeof createPortfolioProjectPhotoRepository>,
  input: {
    readonly attachmentId: PortfolioProjectPhotoAttachmentId;
    readonly currentRevision: number;
  },
): Promise<void> {
  const [before] = await sql<
    { readonly commandCount: number; readonly revisionCount: number }[]
  >`
    SELECT
      (SELECT count(*)::integer FROM portfolio_photo_commands
        WHERE portfolio_project_id = ${portfolioProjectId}) AS "commandCount",
      (SELECT count(*)::integer FROM portfolio_photo_revisions
        WHERE portfolio_project_id = ${portfolioProjectId}) AS "revisionCount"
  `;
  if (before === undefined) throw new Error("Expected suspension baseline.");
  const command = {
    actorUserId: ownerUserId,
    attachmentId: input.attachmentId,
    commandId: randomUUID(),
    craftsmanProfileId,
    expectedRevision: input.currentRevision,
    phase: "PROGRESS" as const,
    portfolioProjectId,
  };
  const [result] = await Promise.all([
    photos.setPhase(command),
    sql.begin(async (transaction) => {
      await transaction`SELECT id FROM users WHERE id = ${ownerUserId} FOR UPDATE`;
      await transaction`
        UPDATE users SET account_state = 'SUSPENDED',
          account_state_changed_at = changed.at, updated_at = changed.at
        FROM (SELECT clock_timestamp() AS at) changed
        WHERE users.id = ${ownerUserId}
      `;
    }),
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(result.status);
  const [after] = await sql<
    { readonly commandCount: number; readonly revisionCount: number }[]
  >`
    SELECT
      (SELECT count(*)::integer FROM portfolio_photo_commands
        WHERE portfolio_project_id = ${portfolioProjectId}) AS "commandCount",
      (SELECT count(*)::integer FROM portfolio_photo_revisions
        WHERE portfolio_project_id = ${portfolioProjectId}) AS "revisionCount"
  `;
  if (after === undefined) throw new Error("Expected suspension evidence.");
  const expectedDelta = result.status === "APPLIED" ? 1 : 0;
  expect(after.commandCount - before.commandCount).toBe(expectedDelta);
  expect(after.revisionCount - before.revisionCount).toBe(expectedDelta);
  await expect(photos.setPhase(command)).resolves.toEqual({
    status: "PROFILE_UNAVAILABLE",
  });
  await expect(
    preparePortfolioPhotoUpload(sql, {
      actorUserId: ownerUserId,
      craftsmanProfileId,
      expectedProjectRevision: 1,
      portfolioProjectId,
    }),
  ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
}

async function createInvalidAssets(
  sql: Sql,
  ownerUserId: UserId,
  otherUserId: UserId,
  projectId: PortfolioProjectId,
): Promise<readonly string[]> {
  const foreign = await insertReadyImage(sql, {
    ownerUserId: otherUserId,
    portfolioProjectId: projectId,
    provenanceRevision: 1,
  });
  const wrongPurpose = await insertReadyImage(sql, {
    ownerUserId,
    portfolioProjectId: projectId,
    provenanceRevision: 1,
    purpose: "PROFILE_IMAGE",
  });
  const wrongProvenance = await insertReadyImage(sql, {
    ownerUserId,
    portfolioProjectId: randomUUID() as PortfolioProjectId,
    provenanceRevision: 1,
  });
  const processing = randomUUID();
  await sql`
    INSERT INTO media_assets (
      id, owner_user_id, uploaded_by_user_id, kind, purpose, status,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision
    ) VALUES (${processing}, ${ownerUserId}, ${ownerUserId}, 'IMAGE',
      'PORTFOLIO_IMAGE', 'PROCESSING', 'image/jpeg', 100,
      'PORTFOLIO_PROJECT', ${projectId}, 1)
  `;
  const rejected = randomUUID();
  await sql`
    INSERT INTO media_assets (
      id, owner_user_id, uploaded_by_user_id, kind, purpose, status,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision, rejection_code,
      rejected_at, status_changed_at, updated_at
    ) VALUES (${rejected}, ${ownerUserId}, ${ownerUserId}, 'IMAGE',
      'PORTFOLIO_IMAGE', 'REJECTED', 'image/jpeg', 100,
      'PORTFOLIO_PROJECT', ${projectId}, 1, 'INVALID_IMAGE',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  return [foreign, wrongPurpose, wrongProvenance, processing, rejected];
}

async function insertReadyImage(
  sql: Sql,
  input: {
    readonly ownerUserId: UserId;
    readonly portfolioProjectId: PortfolioProjectId;
    readonly provenanceRevision: number;
    readonly purpose?: "PORTFOLIO_IMAGE" | "PROFILE_IMAGE";
  },
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO media_assets (
      id, owner_user_id, uploaded_by_user_id, kind, purpose, status,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision, ready_at,
      status_changed_at, updated_at, canonical_width, canonical_height
    ) VALUES (${id}, ${input.ownerUserId}, ${input.ownerUserId}, 'IMAGE',
      ${input.purpose ?? "PORTFOLIO_IMAGE"}, 'READY', 'image/jpeg', 100,
      'PORTFOLIO_PROJECT', ${input.portfolioProjectId},
      ${input.provenanceRevision}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, 1200, 900)
  `;
  await sql`
    INSERT INTO media_asset_storage_objects (
      media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256
    ) VALUES (${id}, 'CANONICAL', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'image/webp', 80,
      ${"a".repeat(64)})
  `;
  return id;
}

function deliverySnapshot(
  actorUserId: UserId,
  projectId: PortfolioProjectId,
  mediaAssetId: string,
): PrivateMediaDeliverySnapshot {
  const now = new Date("2026-09-14T08:00:00Z");
  return {
    actor: { accountState: "ACTIVE", userId: actorUserId },
    asset: {
      id: mediaAssetId,
      ownerUserId: actorUserId,
      provenanceEntityId: projectId,
      provenanceEntityRevision: 1,
      provenanceEntityType: "PORTFOLIO_PROJECT",
      purpose: "PORTFOLIO_IMAGE",
      status: "READY",
      updatedAt: now,
    },
    object: {
      contentType: "image/webp",
      createdAt: now,
      id: randomUUID(),
      revokedAt: null,
      role: "CANONICAL",
      storageObject: {
        area: "private",
        key: asStorageObjectKey(`private/2026/09/${randomUUID()}`),
      },
    },
  };
}

function photoCommand<T extends object>(input: T): T {
  return input;
}
