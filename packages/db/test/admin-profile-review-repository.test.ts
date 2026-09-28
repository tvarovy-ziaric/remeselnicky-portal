import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createAdminProfileReviewRepository } from "../src/admin-profile-review-repository.js";

const firstProfileId = "b1000000-0000-4000-8000-000000000001";
const secondProfileId = "b1000000-0000-4000-8000-000000000002";

describe("administrative profile-review read model", () => {
  it("returns a bounded PENDING queue with a stable opaque cursor", async () => {
    const sql = scriptedSql([[row(firstProfileId), row(secondProfileId)]]);
    const page = await createAdminProfileReviewRepository(sql).listPending({
      limit: 1,
    });

    expect(page).toMatchObject({
      items: [
        {
          about: "Poctivá stolárska výroba.",
          baseMunicipality: { code: "SK0101528595", name: "Bratislava" },
          identity: {
            primaryName: "Majster Jano",
            profileType: "INDIVIDUAL",
            secondaryName: "Ján Remeselný",
          },
          normalRadiusMeters: 25_000,
          profileId: firstProfileId,
          publicationRevision: 2,
          readiness: { isReady: true, missing: [] },
        },
      ],
      nextCursor: firstProfileId,
    });
    expect(page.items[0]?.professions).toEqual([
      { code: "PROF:CARPENTER", declaredLevel: "MASTER", label: "Stolár" },
    ]);
    const query = sql.queries.join("\n");
    expect(query).toContain("publication.review_state = 'PENDING'");
    expect(query).toContain("owner.account_state = 'ACTIVE'");
    expect(query).toContain("profession.state = 'ACTIVE'");
    expect(query).toContain("ORDER BY profile.id");
    expect(query).not.toMatch(
      /email|phone|identity_verification_reference|company_registration_verification_reference|session_id|mfa_|audit_events|password|storage_key/iu,
    );
    expect(JSON.stringify(page)).not.toMatch(
      /ownerUserId|email|phone|verificationReference|session|mfa|audit/iu,
    );
  });

  it("returns one exact pending detail and uniform absence", async () => {
    const foundSql = scriptedSql([[row(firstProfileId)]]);
    await expect(
      createAdminProfileReviewRepository(foundSql).findPending(firstProfileId),
    ).resolves.toMatchObject({ profileId: firstProfileId });

    const missingSql = scriptedSql([[]]);
    await expect(
      createAdminProfileReviewRepository(missingSql).findPending(
        secondProfileId,
      ),
    ).resolves.toBeNull();

    const malformedSql = scriptedSql([]);
    await expect(
      createAdminProfileReviewRepository(malformedSql).findPending(
        "not-a-uuid",
      ),
    ).resolves.toBeNull();
    expect(malformedSql.queries).toEqual([]);
  });

  it("keeps a dynamically incomplete PENDING profile visible for a safe rejection", async () => {
    const sql = scriptedSql([
      [
        {
          ...row(firstProfileId),
          about: null,
          baseMunicipalityCode: null,
          baseMunicipalityName: null,
          missingRequirements: ["ABOUT", "BASE_MUNICIPALITY"],
          normalRadiusMeters: null,
        },
      ],
    ]);
    const detail =
      await createAdminProfileReviewRepository(sql).findPending(firstProfileId);
    expect(detail).toMatchObject({
      about: null,
      baseMunicipality: null,
      normalRadiusMeters: null,
      readiness: {
        isReady: false,
        missing: ["ABOUT", "BASE_MUNICIPALITY"],
      },
    });
    expect(sql.queries[0]).toContain(
      "LEFT JOIN current_craftsman_service_areas",
    );
  });

  it("rejects unbounded or malformed queue requests before SQL", async () => {
    for (const input of [
      { limit: 0 },
      { limit: 51 },
      { limit: 10, cursor: "not-a-uuid" },
    ]) {
      const sql = scriptedSql([]);
      await expect(
        createAdminProfileReviewRepository(sql).listPending(input),
      ).rejects.toBeInstanceOf(TypeError);
      expect(sql.queries).toEqual([]);
    }
  });

  it("fails closed when the database projection has an unexpected shape", async () => {
    const sql = scriptedSql([
      [{ ...row(firstProfileId), professions: [{ code: "PROF:CARPENTER" }] }],
    ]);
    await expect(
      createAdminProfileReviewRepository(sql).listPending({ limit: 10 }),
    ).rejects.toThrow("Invalid administrative profession projection");
  });
});

interface ScriptedSql extends Sql {
  readonly queries: string[];
}

function scriptedSql(responses: unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, { queries });
  return tagged;
}

function row(profileId: string) {
  return {
    about: "Poctivá stolárska výroba.",
    baseMunicipalityCode: "SK0101528595",
    baseMunicipalityName: "Bratislava",
    missingRequirements: [],
    normalRadiusMeters: 25_000,
    primaryName: "Majster Jano",
    professions: [
      {
        code: "PROF:CARPENTER",
        declaredLevel: "MASTER",
        label: "Stolár",
      },
    ],
    profileId,
    profileType: "INDIVIDUAL",
    publicationRevision: 2,
    secondaryName: "Ján Remeselný",
    submittedAt: new Date("2026-09-28T12:00:00.000Z"),
  } as const;
}
