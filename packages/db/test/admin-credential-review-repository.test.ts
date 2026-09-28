import type { PrivateMediaDeliverySnapshot } from "@portal/media";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createAdminCredentialReviewRepository,
  createCredentialReviewerMediaAccessResolver,
} from "../src/admin-credential-review-repository.js";

const firstClaimId = "a3100000-0000-4000-8000-000000000001";
const secondClaimId = "a3100000-0000-4000-8000-000000000002";
const profileId = "a3100000-0000-4000-8000-000000000003";
const professionId = "a3100000-0000-4000-8000-000000000004";
const assetId = "a3100000-0000-4000-8000-000000000005";
const ownerUserId = "a3100000-0000-4000-8000-000000000006";

describe("administrative credential-review repository", () => {
  it("returns a bounded PENDING queue with stable pagination and a privacy-minimal projection", async () => {
    const sql = scriptedSql([
      [reviewRow(firstClaimId), reviewRow(secondClaimId)],
    ]);

    const page = await createAdminCredentialReviewRepository(sql).listPending({
      limit: 1,
    });

    expect(page).toEqual({
      items: [
        {
          claimId: firstClaimId,
          createdAt: new Date("2026-09-28T10:00:00.000Z"),
          credentialTypeCode: "test.electrician",
          evidence: [
            {
              assetId,
              attachedAt: new Date("2026-09-28T10:03:00.000Z"),
              mediaKind: "DOCUMENT",
            },
          ],
          evidenceRequirement: "REQUIRED",
          expiresOn: "2027-09-28",
          profession: {
            code: "PROF:ELECTRICIAN",
            id: professionId,
            label: "Elektrikár",
          },
          profile: {
            id: profileId,
            primaryName: "Test Remeselník",
            profileType: "INDIVIDUAL",
            secondaryName: "Ján Testovací",
          },
          revision: 2,
          state: "PENDING",
          updatedAt: new Date("2026-09-28T10:03:00.000Z"),
        },
      ],
      nextCursor: firstClaimId,
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0]?.evidence)).toBe(true);

    const query = sql.queries.join("\n");
    expect(query).toContain("claim.state = 'PENDING'");
    expect(query).toContain("owner.account_state = 'ACTIVE'");
    expect(query).toContain("ORDER BY claim.id");
    expect(query).toContain("item.claim_id = claim.id");
    expect(query).not.toMatch(
      /email|phone|password|session_id|mfa_|storage_key|sha256|malware/iu,
    );
    expect(JSON.stringify(page)).not.toMatch(
      /ownerUserId|email|phone|password|session|mfa|storageKey|sha256|malware/iu,
    );
  });

  it("returns an exact reviewable detail, including APPROVED, and uniform absence", async () => {
    const foundSql = scriptedSql([
      [reviewRow(firstClaimId, { state: "APPROVED" })],
    ]);
    await expect(
      createAdminCredentialReviewRepository(foundSql).findReviewable(
        firstClaimId,
      ),
    ).resolves.toMatchObject({ claimId: firstClaimId, state: "APPROVED" });
    expect(foundSql.values[0]).toContain(firstClaimId);
    expect(foundSql.queries[0]).toContain("claim.id =");

    const missingSql = scriptedSql([[]]);
    await expect(
      createAdminCredentialReviewRepository(missingSql).findReviewable(
        secondClaimId,
      ),
    ).resolves.toBeNull();

    const malformedSql = scriptedSql([]);
    await expect(
      createAdminCredentialReviewRepository(malformedSql).findReviewable(
        "not-a-uuid",
      ),
    ).resolves.toBeNull();
    expect(malformedSql.queries).toEqual([]);
  });

  it("rejects malformed or unbounded page inputs before SQL", async () => {
    for (const input of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { cursor: "not-a-uuid", limit: 10 },
    ]) {
      const sql = scriptedSql([]);
      await expect(
        createAdminCredentialReviewRepository(sql).listPending(input),
      ).rejects.toBeInstanceOf(TypeError);
      expect(sql.queries).toEqual([]);
    }
  });

  it("fails closed on malformed or duplicate evidence projections", async () => {
    const malformed = scriptedSql([
      [reviewRow(firstClaimId, { evidence: [{ assetId: "not-a-uuid" }] })],
    ]);
    await expect(
      createAdminCredentialReviewRepository(malformed).listPending({
        limit: 10,
      }),
    ).rejects.toThrow("Invalid credential-review evidence projection");

    const evidence = reviewRow(firstClaimId).evidence;
    const duplicate = scriptedSql([
      [reviewRow(firstClaimId, { evidence: [...evidence, ...evidence] })],
    ]);
    await expect(
      createAdminCredentialReviewRepository(duplicate).listPending({
        limit: 10,
      }),
    ).rejects.toThrow("Duplicate credential-review evidence projection");
  });

  it("grants credential-reviewer access only for the exact attached evidence relation", async () => {
    const sql = scriptedSql([
      [
        {
          attachedRevision: 2,
          claimId: firstClaimId,
          claimRevision: 3,
          claimState: "PENDING",
          ownerUserId,
        },
      ],
    ]);

    await expect(
      createCredentialReviewerMediaAccessResolver(
        sql,
      ).resolvePrivateMediaAccess(snapshot()),
    ).resolves.toMatchObject({
      grants: ["CREDENTIAL_REVIEWER"],
      revision: `credential:${firstClaimId}:3:PENDING:2`,
    });
    expect(sql.queries[0]).toContain("evidence.media_asset_id =");
    expect(sql.queries[0]).toContain("claim.id =");
    expect(sql.queries[0]).toContain("claim.state IN ('PENDING', 'APPROVED')");
    expect(sql.queries[0]).toContain("admin_role_grants");
    expect(sql.queries[0]).toContain("reviewer.account_state = 'ACTIVE'");
    expect(sql.values[0]).toEqual([
      assetId,
      firstClaimId,
      snapshot().actor.userId,
    ]);
    expect(sql.queries[0]).not.toMatch(/storage_key|email|phone|password/iu);
  });

  it("denies unsupported purpose and provenance before querying the relation", async () => {
    for (const changedAsset of [
      { purpose: "PROFILE_IMAGE" as const },
      { provenanceEntityType: "USER_PROFILE" as const },
      { provenanceEntityId: null },
      { provenanceEntityRevision: null },
    ]) {
      const sql = scriptedSql([]);
      const access = await createCredentialReviewerMediaAccessResolver(
        sql,
      ).resolvePrivateMediaAccess({
        ...snapshot(),
        asset: { ...snapshot().asset, ...changedAsset },
      });
      expect(access.grants).toEqual([]);
      expect(sql.queries).toEqual([]);
    }
  });

  it.each([
    ["missing binding", undefined],
    [
      "foreign owner",
      {
        attachedRevision: 2,
        claimId: firstClaimId,
        claimRevision: 3,
        claimState: "PENDING",
        ownerUserId: "a3100000-0000-4000-8000-000000000099",
      },
    ],
    [
      "wrong attachment revision",
      {
        attachedRevision: 3,
        claimId: firstClaimId,
        claimRevision: 3,
        claimState: "PENDING",
        ownerUserId,
      },
    ],
    [
      "claim revision behind attachment",
      {
        attachedRevision: 2,
        claimId: firstClaimId,
        claimRevision: 1,
        claimState: "PENDING",
        ownerUserId,
      },
    ],
    [
      "non-reviewable state",
      {
        attachedRevision: 2,
        claimId: firstClaimId,
        claimRevision: 3,
        claimState: "REVOKED",
        ownerUserId,
      },
    ],
    [
      "malformed claim binding",
      {
        attachedRevision: 2,
        claimId: "not-a-uuid",
        claimRevision: 3,
        claimState: "PENDING",
        ownerUserId,
      },
    ],
  ])("denies %s without exposing a reviewer grant", async (_name, row) => {
    const sql = scriptedSql([row === undefined ? [] : [row]]);
    await expect(
      createCredentialReviewerMediaAccessResolver(
        sql,
      ).resolvePrivateMediaAccess(snapshot()),
    ).resolves.toMatchObject({ grants: [] });
  });
});

interface ScriptedSql extends Sql {
  readonly queries: string[];
  readonly values: unknown[][];
}

function scriptedSql(responses: unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const values: unknown[][] = [];
  const tagged = vi.fn(
    (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      queries.push(strings.join("?"));
      values.push(parameters);
      return Promise.resolve(queue.shift() ?? []);
    },
  ) as unknown as ScriptedSql;
  Object.assign(tagged, { queries, values });
  return tagged;
}

function reviewRow(claimId: string, overrides: Record<string, unknown> = {}) {
  return {
    claimId,
    createdAt: new Date("2026-09-28T10:00:00.000Z"),
    credentialTypeCode: "test.electrician",
    evidence: [
      {
        assetId,
        attachedAt: "2026-09-28T10:03:00.000Z",
        mediaKind: "DOCUMENT",
      },
    ],
    evidenceRequirement: "REQUIRED",
    expiresOn: "2027-09-28",
    primaryName: "Test Remeselník",
    professionCode: "PROF:ELECTRICIAN",
    professionId,
    professionLabel: "Elektrikár",
    profileId,
    profileType: "INDIVIDUAL",
    revision: 2,
    secondaryName: "Ján Testovací",
    state: "PENDING",
    updatedAt: new Date("2026-09-28T10:03:00.000Z"),
    ...overrides,
  };
}

function snapshot(): PrivateMediaDeliverySnapshot {
  return {
    actor: {
      accountState: "ACTIVE",
      userId: "a3100000-0000-4000-8000-000000000007" as never,
    },
    asset: {
      id: assetId,
      ownerUserId: ownerUserId as never,
      provenanceEntityId: firstClaimId,
      provenanceEntityRevision: 1,
      provenanceEntityType: "CREDENTIAL",
      purpose: "CREDENTIAL_DOCUMENT",
      status: "READY",
      updatedAt: new Date("2026-09-28T10:02:00.000Z"),
    },
    object: {
      contentType: "application/pdf",
      createdAt: new Date("2026-09-28T10:02:00.000Z"),
      id: "a3100000-0000-4000-8000-000000000008",
      revokedAt: null,
      role: "CANONICAL",
      storageObject: {
        area: "private",
        key: "private/2026/09/a3100000-0000-4000-8000-000000000009" as never,
      },
    },
  };
}
