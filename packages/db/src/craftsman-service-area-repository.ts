import { createHash } from "node:crypto";

import {
  assertCraftsmanServiceAreaReadInput,
  assertReplaceCraftsmanServiceAreaInput,
  normalizeTravelFeePolicy,
  type CraftsmanProfileId,
  type CraftsmanServiceArea,
  type CraftsmanServiceAreaPersistence,
  type CraftsmanServiceAreaRevisionId,
  type MunicipalityCode,
  type ReplaceCraftsmanServiceAreaInput,
  type ReplaceCraftsmanServiceAreaResult,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface OwnedProfileRow {
  readonly accountState: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  readonly ownerUserId: string;
}

interface CommandRow {
  readonly actorUserId: string;
  readonly craftsmanProfileId: string;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

interface ServiceAreaRow {
  readonly baseMunicipalityCode: string | null;
  readonly craftsmanProfileId: string;
  readonly createdAt: Date;
  readonly extraMunicipalityCodes: string[];
  readonly id: string;
  readonly maximumRadiusMeters: number | null;
  readonly normalRadiusMeters: number | null;
  readonly revision: number;
  readonly travelFeePolicy: string | null;
  readonly travelFeeThresholdMeters: number | null;
}

export class CraftsmanServiceAreaIdempotencyError extends Error {
  readonly code = "CRAFTSMAN_SERVICE_AREA_IDEMPOTENCY_CONFLICT";
}

export function createCraftsmanServiceAreaRepository(
  sql: Sql,
): CraftsmanServiceAreaPersistence {
  return Object.freeze({
    async replaceOwnedDraft(
      supplied: ReplaceCraftsmanServiceAreaInput,
    ): Promise<ReplaceCraftsmanServiceAreaResult> {
      const input = canonicalInput(supplied);
      assertReplaceCraftsmanServiceAreaInput(input);
      const payloadFingerprint = fingerprint(input);

      return sql.begin(async (transaction) => {
        const owner = await lockOwnedProfile(transaction, input);
        if (
          owner === undefined ||
          owner.ownerUserId !== input.actorUserId ||
          owner.accountState !== "ACTIVE"
        ) {
          return Object.freeze({ status: "PROFILE_UNAVAILABLE" });
        }

        const [priorCommand] = await transaction<CommandRow[]>`
          SELECT
            actor_user_id AS "actorUserId",
            craftsman_profile_id AS "craftsmanProfileId",
            payload_fingerprint AS "payloadFingerprint",
            resulting_revision AS "resultingRevision"
          FROM craftsman_service_area_commands
          WHERE command_id = ${input.commandId}
        `;
        if (priorCommand !== undefined) {
          if (
            priorCommand.actorUserId !== input.actorUserId ||
            priorCommand.craftsmanProfileId !== input.craftsmanProfileId ||
            priorCommand.payloadFingerprint !== payloadFingerprint
          ) {
            throw new CraftsmanServiceAreaIdempotencyError(
              "Service-area command id was reused for a different intent.",
            );
          }
          const replay = await selectRevision(
            transaction,
            input.craftsmanProfileId,
            priorCommand.resultingRevision,
          );
          if (replay === null) {
            throw new Error(
              "Service-area command points to a missing revision.",
            );
          }
          return Object.freeze({ serviceArea: replay, status: "DEDUPLICATED" });
        }

        const current = await selectRevision(
          transaction,
          input.craftsmanProfileId,
        );
        const currentRevision = current?.revision ?? 0;
        if (input.expectedRevision !== currentRevision) {
          return Object.freeze({ status: "STALE_REVISION" });
        }

        const referencedCodes = [
          ...(input.baseMunicipalityCode === null
            ? []
            : [input.baseMunicipalityCode]),
          ...input.extraMunicipalityCodes,
        ];
        if (
          referencedCodes.length > 0 &&
          !(await lockActiveMunicipalities(transaction, referencedCodes))
        ) {
          return Object.freeze({ status: "LOCATION_NOT_AVAILABLE" });
        }

        if (current !== null && sameServiceArea(current, input)) {
          await insertCommand(
            transaction,
            input,
            payloadFingerprint,
            "UNCHANGED",
            current.revision,
          );
          return Object.freeze({ serviceArea: current, status: "UNCHANGED" });
        }

        const resultingRevision = currentRevision + 1;
        await insertCommand(
          transaction,
          input,
          payloadFingerprint,
          "APPLIED",
          resultingRevision,
        );
        const [created] = await transaction<{ readonly id: string }[]>`
          INSERT INTO craftsman_service_area_revisions (
            craftsman_profile_id,
            command_id,
            revision,
            base_municipality_code,
            normal_radius_meters,
            maximum_radius_meters,
            travel_fee_policy,
            travel_fee_threshold_meters
          ) VALUES (
            ${input.craftsmanProfileId},
            ${input.commandId},
            ${resultingRevision},
            ${input.baseMunicipalityCode},
            ${toMeters(input.normalRadiusKm)},
            ${toMeters(input.maximumRadiusKm)},
            ${input.travelFeePolicy},
            ${toMeters(input.travelFeeThresholdKm)}
          )
          RETURNING id
        `;
        if (created === undefined) {
          throw new Error("Service-area revision insert returned no record.");
        }
        for (const [index, code] of input.extraMunicipalityCodes.entries()) {
          await transaction`
            INSERT INTO craftsman_service_area_extra_municipalities (
              service_area_revision_id, municipality_code, ordinal
            ) VALUES (${created.id}, ${code}, ${index + 1})
          `;
        }

        const serviceArea = await selectRevision(
          transaction,
          input.craftsmanProfileId,
          resultingRevision,
        );
        if (serviceArea === null) {
          throw new Error("Created service-area revision cannot be read back.");
        }
        return Object.freeze({ serviceArea, status: "APPLIED" });
      });
    },

    async findOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
    }): Promise<CraftsmanServiceArea | null> {
      assertCraftsmanServiceAreaReadInput(input);
      const [owned] = await sql<OwnedProfileRow[]>`
        SELECT
          profile.owner_user_id AS "ownerUserId",
          owner.account_state AS "accountState"
        FROM craftsman_profiles profile
        JOIN users owner ON owner.id = profile.owner_user_id
        WHERE profile.id = ${input.craftsmanProfileId}
          AND profile.owner_user_id = ${input.actorUserId}
          AND owner.account_state = 'ACTIVE'
      `;
      if (owned === undefined) return null;
      return selectRevision(sql, input.craftsmanProfileId);
    },
  });
}

function canonicalInput(
  input: ReplaceCraftsmanServiceAreaInput,
): ReplaceCraftsmanServiceAreaInput {
  return Object.freeze({
    ...input,
    extraMunicipalityCodes: Object.freeze([...input.extraMunicipalityCodes]),
    travelFeePolicy: normalizeTravelFeePolicy(input.travelFeePolicy),
  });
}

async function lockOwnedProfile(
  transaction: TransactionSql,
  input: Pick<
    ReplaceCraftsmanServiceAreaInput,
    "actorUserId" | "craftsmanProfileId"
  >,
): Promise<OwnedProfileRow | undefined> {
  const [owned] = await transaction<OwnedProfileRow[]>`
    SELECT
      profile.owner_user_id AS "ownerUserId",
      owner.account_state AS "accountState"
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId}
      AND profile.owner_user_id = ${input.actorUserId}
    FOR UPDATE OF profile, owner
  `;
  return owned;
}

async function lockActiveMunicipalities(
  transaction: TransactionSql,
  codes: readonly MunicipalityCode[],
): Promise<boolean> {
  const uniqueCodes = [...new Set(codes)];
  const rows = await transaction<{ readonly code: string }[]>`
    SELECT code
    FROM location_municipalities
    WHERE code = ANY(${uniqueCodes}::text[])
      AND is_active
    FOR SHARE
  `;
  return rows.length === uniqueCodes.length;
}

async function insertCommand(
  transaction: TransactionSql,
  input: ReplaceCraftsmanServiceAreaInput,
  payloadFingerprint: string,
  resultKind: "APPLIED" | "UNCHANGED",
  resultingRevision: number,
): Promise<void> {
  await transaction`
    INSERT INTO craftsman_service_area_commands (
      command_id,
      craftsman_profile_id,
      actor_user_id,
      expected_revision,
      result_kind,
      resulting_revision,
      base_municipality_code,
      normal_radius_meters,
      maximum_radius_meters,
      extra_municipality_codes,
      travel_fee_policy,
      travel_fee_threshold_meters,
      payload_fingerprint
    ) VALUES (
      ${input.commandId},
      ${input.craftsmanProfileId},
      ${input.actorUserId},
      ${input.expectedRevision},
      ${resultKind},
      ${resultingRevision},
      ${input.baseMunicipalityCode},
      ${toMeters(input.normalRadiusKm)},
      ${toMeters(input.maximumRadiusKm)},
      ${transaction.json([...input.extraMunicipalityCodes])},
      ${input.travelFeePolicy},
      ${toMeters(input.travelFeeThresholdKm)},
      ${payloadFingerprint}
    )
  `;
}

async function selectRevision(
  sql: Sql | TransactionSql,
  craftsmanProfileId: CraftsmanProfileId,
  revision?: number,
): Promise<CraftsmanServiceArea | null> {
  const rows =
    revision === undefined
      ? await sql<ServiceAreaRow[]>`
        SELECT
          current.id,
          current.craftsman_profile_id AS "craftsmanProfileId",
          current.revision,
          current.base_municipality_code AS "baseMunicipalityCode",
          current.normal_radius_meters AS "normalRadiusMeters",
          current.maximum_radius_meters AS "maximumRadiusMeters",
          current.travel_fee_policy AS "travelFeePolicy",
          current.travel_fee_threshold_meters AS "travelFeeThresholdMeters",
          current.created_at AS "createdAt",
          COALESCE(
            array_agg(extra.municipality_code ORDER BY extra.ordinal)
              FILTER (WHERE extra.municipality_code IS NOT NULL),
            ARRAY[]::text[]
          ) AS "extraMunicipalityCodes"
        FROM current_craftsman_service_areas current
        LEFT JOIN craftsman_service_area_extra_municipalities extra
          ON extra.service_area_revision_id = current.id
        WHERE current.craftsman_profile_id = ${craftsmanProfileId}
        GROUP BY current.id, current.craftsman_profile_id, current.revision,
          current.base_municipality_code, current.normal_radius_meters,
          current.maximum_radius_meters, current.travel_fee_policy,
          current.travel_fee_threshold_meters, current.created_at
      `
      : await sql<ServiceAreaRow[]>`
        SELECT
          stored.id,
          stored.craftsman_profile_id AS "craftsmanProfileId",
          stored.revision,
          stored.base_municipality_code AS "baseMunicipalityCode",
          stored.normal_radius_meters AS "normalRadiusMeters",
          stored.maximum_radius_meters AS "maximumRadiusMeters",
          stored.travel_fee_policy AS "travelFeePolicy",
          stored.travel_fee_threshold_meters AS "travelFeeThresholdMeters",
          stored.created_at AS "createdAt",
          COALESCE(
            array_agg(extra.municipality_code ORDER BY extra.ordinal)
              FILTER (WHERE extra.municipality_code IS NOT NULL),
            ARRAY[]::text[]
          ) AS "extraMunicipalityCodes"
        FROM craftsman_service_area_revisions stored
        LEFT JOIN craftsman_service_area_extra_municipalities extra
          ON extra.service_area_revision_id = stored.id
        WHERE stored.craftsman_profile_id = ${craftsmanProfileId}
          AND stored.revision = ${revision}
        GROUP BY stored.id
      `;
  return rows[0] === undefined ? null : mapServiceArea(rows[0]);
}

function mapServiceArea(row: ServiceAreaRow): CraftsmanServiceArea {
  return Object.freeze({
    baseMunicipalityCode: row.baseMunicipalityCode as MunicipalityCode | null,
    craftsmanProfileId: row.craftsmanProfileId as CraftsmanProfileId,
    createdAt: row.createdAt,
    extraMunicipalityCodes: Object.freeze(
      row.extraMunicipalityCodes.map((code) => code as MunicipalityCode),
    ),
    id: row.id as CraftsmanServiceAreaRevisionId,
    maximumRadiusKm:
      row.maximumRadiusMeters === null ? null : row.maximumRadiusMeters / 1000,
    normalRadiusKm:
      row.normalRadiusMeters === null ? null : row.normalRadiusMeters / 1000,
    revision: row.revision,
    travelFeePolicy: row.travelFeePolicy,
    travelFeeThresholdKm:
      row.travelFeeThresholdMeters === null
        ? null
        : row.travelFeeThresholdMeters / 1000,
  });
}

function sameServiceArea(
  current: CraftsmanServiceArea,
  input: ReplaceCraftsmanServiceAreaInput,
): boolean {
  return (
    current.baseMunicipalityCode === input.baseMunicipalityCode &&
    current.normalRadiusKm === input.normalRadiusKm &&
    current.maximumRadiusKm === input.maximumRadiusKm &&
    current.travelFeePolicy === input.travelFeePolicy &&
    current.travelFeeThresholdKm === input.travelFeeThresholdKm &&
    current.extraMunicipalityCodes.length ===
      input.extraMunicipalityCodes.length &&
    current.extraMunicipalityCodes.every(
      (code, index) => code === input.extraMunicipalityCodes[index],
    )
  );
}

function fingerprint(input: ReplaceCraftsmanServiceAreaInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.commandId,
        input.craftsmanProfileId,
        input.actorUserId,
        input.expectedRevision,
        input.baseMunicipalityCode,
        input.normalRadiusKm,
        input.maximumRadiusKm,
        input.extraMunicipalityCodes,
        input.travelFeePolicy,
        input.travelFeeThresholdKm,
      ]),
      "utf8",
    )
    .digest("hex");
}

function toMeters(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000);
}
