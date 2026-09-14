import type { CraftsmanProfileId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createPublicCraftsmanProfileRepository } from "../src/public-craftsman-profile-repository.js";

const profileId = "82000000-0000-4000-8000-000000000001" as CraftsmanProfileId;

describe("public craftsman profile repository", () => {
  it("rejects malformed identifiers without opening a database snapshot", async () => {
    const sql = scriptedSql([]);
    await expect(
      sqlRepository(sql).findPublic("not-an-id"),
    ).resolves.toBeNull();
    expect(sql.beginOptions).toEqual([]);
    expect(sql.queries).toEqual([]);
  });

  it("returns the explicit public projection from a repeatable read-only snapshot", async () => {
    const sql = scriptedSql(completeResponses());
    const result = await sqlRepository(sql).findPublic(profileId);

    expect(sql.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
    expect(result).toMatchObject({
      callToAction: { kind: "PLATFORM_JOB_REQUEST" },
      credentials: [
        {
          credentialTypeCode: "trade.woodwork",
          verification: "ADMIN_APPROVED",
        },
      ],
      experience: { source: "SELF_DECLARED", workingSinceYear: 2010 },
      identity: {
        primaryName: "Majster Jano",
        secondaryName: "Ján Remeselný",
      },
      portfolio: [],
      professions: [
        {
          declaredProficiency: { level: "MASTER", source: "SELF_DECLARED" },
          evidenceSupportedProficiency: null,
        },
      ],
      trust: {
        customerScore: null,
        reviewCount: 0,
        verifiedWorkCount: 0,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ownerUserId|email|phone|address|reference|reviewedBy|storage|sha256|risk|completeness/iu,
    );

    const gate = sql.queries[0] ?? "";
    expect(gate).toContain("publication.effectively_public");
    expect(gate).toContain("publication.review_state = 'APPROVED'");
    expect(gate).toContain("publication.owner_visibility = 'PUBLIC'");
    expect(gate).toContain("publication.moderation_state = 'ALLOWED'");
    expect(gate).toContain("owner.account_state = 'ACTIVE'");
    const credentialQuery = sql.queries.at(-1) ?? "";
    expect(credentialQuery).toContain("claim.state = 'APPROVED'");
    expect(credentialQuery).toContain("claim.expires_on >= CURRENT_DATE");
    expect(credentialQuery).not.toMatch(
      /credential_claim_evidence|media_assets/iu,
    );
    expect(sql.queries.join("\n")).not.toMatch(
      /email_addresses|phone_verification|company_registration_number|identity_verification_reference|company_registration_verification_reference|credential_claim_evidence|storage_key|sha256|risk_score|completeness|current_craftsman_availability_blocks|portfolio_projects/iu,
    );
  });

  it("returns the same absence for hidden, suspended, rejected, and unknown profiles", async () => {
    for (let stateCase = 0; stateCase < 4; stateCase += 1) {
      const sql = scriptedSql([[]]);
      await expect(
        sqlRepository(sql).findPublic(profileId),
      ).resolves.toBeNull();
      expect(sql.queries).toHaveLength(1);
    }
  });

  it("fails closed when approved legacy display text contains contact data", async () => {
    const responses = completeResponses();
    responses[0] = [
      {
        ...(responses[0]?.[0] as Record<string, unknown>),
        about: "Kontakt +421 900 123 456",
      },
    ];
    await expect(
      sqlRepository(scriptedSql(responses)).findPublic(profileId),
    ).resolves.toBeNull();
  });
});

interface ScriptedSql extends Sql {
  readonly beginOptions: string[];
  readonly queries: string[];
}

function sqlRepository(sql: Sql) {
  return createPublicCraftsmanProfileRepository(sql);
}

function scriptedSql(responses: unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const beginOptions: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (options: string, work: (transaction: Sql) => Promise<unknown>) => {
      beginOptions.push(options);
      return work(tagged);
    },
    beginOptions,
    queries,
  });
  return tagged;
}

function completeResponses(): unknown[][] {
  return [
    [
      {
        about: "Stolárske práce s dôrazom na poctivé remeslo.",
        baseMunicipalityCode: "SK0101528595",
        baseMunicipalityName: "Bratislava",
        companyRegistrationVerified: false,
        identityVerified: true,
        nickname: "Majster Jano",
        normalRadiusMeters: 25_000,
        officialCompanyName: null,
        profileType: "INDIVIDUAL",
        realFirstName: "Ján",
        realLastName: "Remeselný",
        email: "must-not-leak@example.test",
        identityVerificationReference: "internal:identity",
      },
    ],
    [{ code: "SK0101528595", name: "Bratislava" }],
    [
      {
        code: "PROF:CARPENTER",
        declaredLevel: "MASTER",
        evidenceSupportedLevel: null,
        label: "Stolár",
      },
    ],
    [
      {
        canonicalCode: "SKILL:FURNITURE",
        evidenceSupportedAt: null,
        label: "Výroba nábytku",
        professionCodes: ["PROF:CARPENTER"],
      },
    ],
    [
      {
        code: "SPEC:CABINET",
        evidenceSupportedAt: null,
        label: "Nábytkárstvo",
        professionCode: "PROF:CARPENTER",
      },
    ],
    [
      {
        amountCents: "5000",
        mode: "FROM",
        note: null,
        professionCode: "PROF:CARPENTER",
        serviceName: "Montáž nábytku",
      },
    ],
    [{ workingSinceYear: 2010 }],
    [
      {
        credentialTypeCode: "trade.woodwork",
        expiresOn: "2030-01-01",
        professionCode: "PROF:CARPENTER",
        reviewedByUserId: "must-not-leak",
        storageKey: "must-not-leak",
      },
    ],
  ];
}
