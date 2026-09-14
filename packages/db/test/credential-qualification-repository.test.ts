import {
  createCredentialQualificationGate,
  prepareCredentialQualificationPolicyRelease,
} from "@portal/search";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createCredentialQualificationRepository } from "../src/credential-qualification-repository.js";

const input = Object.freeze({
  craftsmanProfileId: "76000000-0000-4000-8000-000000000001",
  credentialTypeCode: "test.required-license",
  professionCode: "PROF:ELECTRICIAN",
});

describe("credential qualification repository", () => {
  it("accepts only an exact idempotent activation replay", async () => {
    const activation = {
      activationId: "76000000-0000-4000-8000-000000000020",
      actorReference: "deployment:R2-006",
      previousReleaseId: null,
      releaseId: "76000000-0000-4000-8000-000000000010",
      reviewReference: "legal-review:R2-006-fixture",
    };
    const exact = scriptedSql([
      [],
      [
        {
          actorReference: activation.actorReference,
          previousReleaseId: activation.previousReleaseId,
          releaseId: activation.releaseId,
          reviewReference: activation.reviewReference,
        },
      ],
    ]);
    await expect(
      createCredentialQualificationRepository(exact).activateRelease(
        activation,
      ),
    ).resolves.toBe(false);

    const conflicting = scriptedSql([
      [],
      [
        {
          actorReference: "deployment:someone-else",
          previousReleaseId: null,
          releaseId: activation.releaseId,
          reviewReference: activation.reviewReference,
        },
      ],
    ]);
    await expect(
      createCredentialQualificationRepository(conflicting).activateRelease(
        activation,
      ),
    ).rejects.toThrow(/conflicts/u);
  });

  it("reports a newly recorded activation", async () => {
    const sql = scriptedSql([[{ activationId: input.craftsmanProfileId }]]);
    await expect(
      createCredentialQualificationRepository(sql).activateRelease({
        activationId: "76000000-0000-4000-8000-000000000020",
        actorReference: "deployment:R2-006",
        previousReleaseId: null,
        releaseId: "76000000-0000-4000-8000-000000000010",
        reviewReference: "legal-review:R2-006-fixture",
      }),
    ).resolves.toBe(true);
    expect(sql.queries).toHaveLength(1);
  });

  it("executes one exact gate statement and strips unexpected columns", async () => {
    const sql = scriptedSql([
      [
        {
          claimId: "private",
          currentApproved: true,
          eligibility: "QUALIFIED",
          reasonCode: "REQUIRED_CREDENTIAL_APPROVED",
          requirement: "REQUIRED",
          storageKey: "private/key",
        },
      ],
    ]);
    const result = await createCredentialQualificationGate(
      createCredentialQualificationRepository(sql),
    ).evaluate(input);
    expect(result).toEqual({
      currentApproved: true,
      eligible: true,
      reasonCode: "REQUIRED_CREDENTIAL_APPROVED",
      requirement: "REQUIRED",
      status: "OK",
    });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toContain(
      "evaluate_craftsman_credential_qualification",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /claim|storage|evidence|review/iu,
    );
  });

  it("fails closed for no row, duplicate rows or incoherent DB output", async () => {
    for (const response of [
      [],
      [validRow(), validRow()],
      [{ ...validRow(), currentApproved: false }],
    ]) {
      const result = await createCredentialQualificationGate(
        createCredentialQualificationRepository(scriptedSql([response])),
      ).evaluate(input);
      expect(result).toEqual({ eligible: false, status: "UNAVAILABLE" });
    }
  });

  it("rejects a forged release checksum before touching PostgreSQL", async () => {
    const sql = scriptedSql([]);
    const release = preparedRelease();
    await expect(
      createCredentialQualificationRepository(sql).installRelease({
        ...release,
        checksumSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(/checksum/u);
    expect(sql.queries).toEqual([]);
  });

  it("installs the complete ordered release atomically", async () => {
    const release = preparedRelease();
    const sql = scriptedSql([
      [{ releaseId: release.releaseId }],
      [],
      [
        {
          checksumSha256: release.checksumSha256,
          contentClass: release.contentClass,
          releaseId: release.releaseId,
          reviewReference: release.reviewReference,
          reviewState: release.reviewState,
          supersedesReleaseId: release.supersedesReleaseId,
          taxonomyReleaseId: release.taxonomyReleaseId,
          version: release.version,
        },
      ],
      release.entries.map((entry) => ({ ...entry })),
    ]);
    await expect(
      createCredentialQualificationRepository(sql).installRelease(release),
    ).resolves.toBe("CREATED");
    expect(sql.beginCalls).toBe(1);
    expect(sql.queries.join("\n")).toContain(
      "credential_qualification_policy_entries",
    );
  });
});

function validRow() {
  return {
    currentApproved: true,
    eligibility: "QUALIFIED",
    reasonCode: "REQUIRED_CREDENTIAL_APPROVED",
    requirement: "REQUIRED",
  };
}

function preparedRelease() {
  return prepareCredentialQualificationPolicyRelease({
    entries: [
      {
        credentialTypeCode: "test.required-license",
        professionCode: "PROF:ELECTRICIAN",
        requirement: "REQUIRED",
      },
    ],
    releaseId: "76000000-0000-4000-8000-000000000010",
    reviewReference: "legal-review:R2-006-fixture",
    supersedesReleaseId: null,
    taxonomyReleaseId: "76000000-0000-4000-8000-000000000011",
    version: 1,
  });
}

interface ScriptedSql extends Sql {
  readonly beginCalls: number;
  readonly queries: string[];
}

function scriptedSql(responses: unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  let beginCalls = 0;
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.defineProperties(tagged, {
    beginCalls: { get: () => beginCalls },
    queries: { value: queries },
  });
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => {
      beginCalls += 1;
      return work(tagged);
    },
  });
  return tagged;
}
