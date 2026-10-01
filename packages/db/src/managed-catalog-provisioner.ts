import { createHash } from "node:crypto";

import {
  createManagedCatalogV1Release,
  prepareProfessionTaxonomyRelease,
} from "@portal/taxonomy";
import type { Sql } from "postgres";

import { createProfessionTaxonomyRepository } from "./taxonomy-repository.js";

const REVIEW_REFERENCE = "product-decision:managed-catalog-v1/2026-10-01";

export interface ManagedCatalogProvisionResult {
  readonly activated: boolean;
  readonly aliases: number;
  readonly professions: number;
  readonly releaseId: string;
  readonly services: number;
  readonly version: number;
}

/**
 * Deterministically installs the approved catalog after schema migrations.
 * Existing immutable releases remain untouched; deployed synthetic data is
 * carried only when the predecessor really contains its explicit fixture code.
 */
export async function ensureManagedCatalogV1(
  sql: Sql,
): Promise<ManagedCatalogProvisionResult> {
  const [current] = await sql<
    Array<{
      readonly releaseId: string;
      readonly reviewReference: string | null;
      readonly version: number;
    }>
  >`
    SELECT release.release_id AS "releaseId", release.version,
      release.review_reference AS "reviewReference"
    FROM profession_taxonomy_activation_events activation
    JOIN profession_taxonomy_releases release
      ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC
    LIMIT 1
  `;
  if (current?.reviewReference === REVIEW_REFERENCE) {
    const [counts] = await sql<
      Array<{
        readonly aliases: number;
        readonly professions: number;
        readonly services: number;
      }>
    >`
      SELECT
        (SELECT count(*)::integer FROM taxonomy_professions
          WHERE release_id = ${current.releaseId}) AS professions,
        (SELECT count(*)::integer FROM taxonomy_services
          WHERE release_id = ${current.releaseId}) AS services,
        (SELECT count(*)::integer FROM taxonomy_aliases
          WHERE release_id = ${current.releaseId}) AS aliases
    `;
    if (
      counts === undefined ||
      counts.professions < 45 ||
      counts.services !== 180 ||
      counts.aliases < 450
    ) {
      throw new Error("Managed catalog release is incomplete.");
    }
    return Object.freeze({
      activated: false,
      ...counts,
      releaseId: current.releaseId,
      version: current.version,
    });
  }

  const includeSyntheticFixture =
    current === undefined
      ? false
      : (
          await sql`
              SELECT 1 FROM taxonomy_professions
              WHERE release_id = ${current.releaseId}
                AND profession_code = 'PROF:ALPHA_SYNTHETIC'
              LIMIT 1
            `
        ).length === 1;
  const predecessor = current?.releaseId ?? null;
  const version = (current?.version ?? 0) + 1;
  const releaseId = deterministicUuid(
    `managed-catalog-v1:${predecessor ?? "root"}:${version.toString()}`,
  );
  const release = prepareProfessionTaxonomyRelease(
    createManagedCatalogV1Release({
      includeSyntheticFixture,
      releaseId,
      supersedesReleaseId: predecessor,
      version,
    }),
  );
  const repository = createProfessionTaxonomyRepository(sql);
  await repository.installRelease(release);
  const activated = await repository.activateRelease({
    activationId: deterministicUuid(`managed-catalog-v1:activate:${releaseId}`),
    actorReference: "system:managed-catalog-v1/provisioner",
    previousReleaseId: predecessor,
    releaseId,
    reviewReference: REVIEW_REFERENCE,
  });
  if (!activated) {
    const [active] = await sql<{ readonly releaseId: string }[]>`
      SELECT release_id AS "releaseId"
      FROM profession_taxonomy_activation_events
      ORDER BY activation_sequence DESC LIMIT 1
    `;
    if (active?.releaseId !== releaseId) {
      throw new Error("Managed catalog activation did not become current.");
    }
  }
  return Object.freeze({
    activated,
    aliases: release.aliases.length,
    professions: release.professions.length,
    releaseId,
    services: release.services.length,
    version,
  });
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256")
    .update(value, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
