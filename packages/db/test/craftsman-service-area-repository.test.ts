import { createHash } from "node:crypto";

import type {
  CraftsmanProfileId,
  MunicipalityCode,
  ReplaceCraftsmanServiceAreaInput,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanServiceAreaRepository,
  CraftsmanServiceAreaIdempotencyError,
} from "../src/craftsman-service-area-repository.js";

const ownerUserId = "62000000-0000-4000-8000-000000000001" as UserId;
const nonOwnerUserId = "62000000-0000-4000-8000-000000000002" as UserId;
const profileId = "62000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const baseCode = "TEST:MUNICIPALITY_BASE" as MunicipalityCode;
const extraCode = "TEST:MUNICIPALITY_EXTRA" as MunicipalityCode;

describe("craftsman service-area repository", () => {
  it("fails closed for a non-owner before reading location or history", async () => {
    const sql = scriptedSql([[]]);
    await expect(
      createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft({
        ...command(),
        actorUserId: nonOwnerUserId,
      }),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
  });

  it("creates one immutable revision with normalized municipality references", async () => {
    const sql = scriptedSql([
      [ownedProfile()],
      [],
      [],
      [{ code: baseCode }, { code: extraCode }],
      [],
      [{ id: "62000000-0000-4000-8000-000000000004" }],
      [],
      [serviceAreaRow()],
    ]);
    await expect(
      createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft(command()),
    ).resolves.toMatchObject({
      serviceArea: { baseMunicipalityCode: baseCode, revision: 1 },
      status: "APPLIED",
    });
    const statements = sql.queries.join("\n");
    expect(statements).toMatch(
      /INSERT INTO craftsman_service_area_commands[\s\S]*INSERT INTO craftsman_service_area_revisions[\s\S]*INSERT INTO craftsman_service_area_extra_municipalities/u,
    );
    expect(statements).not.toMatch(/street|house_number|email|phone/u);
  });

  it("rejects stale state and inactive catalog references", async () => {
    const staleSql = scriptedSql([
      [ownedProfile()],
      [],
      [serviceAreaRow({ revision: 2 })],
    ]);
    await expect(
      createCraftsmanServiceAreaRepository(staleSql).replaceOwnedDraft(
        command(),
      ),
    ).resolves.toEqual({ status: "STALE_REVISION" });

    const inactiveSql = scriptedSql([
      [ownedProfile()],
      [],
      [],
      [{ code: baseCode }],
    ]);
    await expect(
      createCraftsmanServiceAreaRepository(inactiveSql).replaceOwnedDraft(
        command(),
      ),
    ).resolves.toEqual({ status: "LOCATION_NOT_AVAILABLE" });
  });

  it("deduplicates an exact retry and rejects command-id intent reuse", async () => {
    const input = command();
    const exactSql = scriptedSql([
      [ownedProfile()],
      [commandRow(input, fingerprint(input))],
      [serviceAreaRow()],
    ]);
    await expect(
      createCraftsmanServiceAreaRepository(exactSql).replaceOwnedDraft(input),
    ).resolves.toMatchObject({ status: "DEDUPLICATED" });

    const conflictSql = scriptedSql([
      [ownedProfile()],
      [commandRow(input, "f".repeat(64))],
    ]);
    await expect(
      createCraftsmanServiceAreaRepository(conflictSql).replaceOwnedDraft(
        input,
      ),
    ).rejects.toThrow(CraftsmanServiceAreaIdempotencyError);
  });

  it("records an exact no-op command without inventing a new revision", async () => {
    const sql = scriptedSql([
      [ownedProfile()],
      [],
      [serviceAreaRow()],
      [{ code: baseCode }, { code: extraCode }],
      [],
    ]);
    await expect(
      createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft({
        ...command(),
        commandId: "62000000-0000-4000-8000-000000000099",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "UNCHANGED" });
    expect(sql.queries.join("\n")).not.toMatch(
      /INSERT INTO craftsman_service_area_revisions/u,
    );
  });

  it("fuses active-owner authorization into the private revision read", async () => {
    const sql = scriptedSql([[serviceAreaRow()]]);
    await expect(
      createCraftsmanServiceAreaRepository(sql).findOwned({
        actorUserId: ownerUserId,
        craftsmanProfileId: profileId,
      }),
    ).resolves.toMatchObject({ revision: 1 });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toMatch(
      /FROM current_craftsman_service_areas current[\s\S]*JOIN users owner[\s\S]*profile\.owner_user_id[\s\S]*owner\.account_state = 'ACTIVE'/u,
    );

    await expect(
      createCraftsmanServiceAreaRepository(scriptedSql([[]])).findOwned({
        actorUserId: ownerUserId,
        craftsmanProfileId: profileId,
      }),
    ).resolves.toBeNull();
  });
});

interface ScriptedSql extends Sql {
  readonly queries: string[];
}

function scriptedSql(responses: readonly unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => work(tagged),
    json: (value: unknown) => value,
    queries,
  });
  return tagged;
}

function command(): ReplaceCraftsmanServiceAreaInput {
  return {
    actorUserId: ownerUserId,
    baseMunicipalityCode: baseCode,
    commandId: "62000000-0000-4000-8000-000000000010",
    craftsmanProfileId: profileId,
    expectedRevision: 0,
    extraMunicipalityCodes: [extraCode],
    maximumRadiusKm: 75,
    normalRadiusKm: 25,
    travelFeePolicy: "Cestovné ďalej podľa dohody v cenovej ponuke.",
    travelFeeThresholdKm: 30,
  };
}

function ownedProfile() {
  return { accountState: "ACTIVE", ownerUserId };
}

function serviceAreaRow(options: { readonly revision?: number } = {}) {
  return {
    baseMunicipalityCode: baseCode,
    craftsmanProfileId: profileId,
    createdAt: new Date("2026-09-14T12:00:00.000Z"),
    extraMunicipalityCodes: [extraCode],
    id: "62000000-0000-4000-8000-000000000004",
    maximumRadiusMeters: 75_000,
    normalRadiusMeters: 25_000,
    revision: options.revision ?? 1,
    travelFeePolicy: "Cestovné ďalej podľa dohody v cenovej ponuke.",
    travelFeeThresholdMeters: 30_000,
  };
}

function commandRow(input: ReplaceCraftsmanServiceAreaInput, hash: string) {
  return {
    actorUserId: input.actorUserId,
    craftsmanProfileId: input.craftsmanProfileId,
    payloadFingerprint: hash,
    resultingRevision: 1,
  };
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
