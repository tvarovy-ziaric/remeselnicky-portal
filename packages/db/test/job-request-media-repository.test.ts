import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

import {
  createJobRequestMediaAccessResolver,
  createJobRequestMediaUploadAuthorization,
} from "../src/job-request-media-repository.js";

const actorUserId = "94000000-0000-4000-8000-000000000001";
const jobRequestId = "94000000-0000-4000-8000-000000000002";

describe("job request media upload authorization", () => {
  it("lists only allowlisted upload state through one active-owner query", async () => {
    const sql = scriptedSql([
      [
        {
          assetId: "94000000-0000-4000-8000-000000000003",
          kind: "IMAGE",
          status: "PROCESSING",
        },
      ],
    ]);
    await expect(
      createJobRequestMediaUploadAuthorization(sql).listOwnedUploads({
        actorUserId,
        jobRequestId,
      }),
    ).resolves.toEqual([
      {
        assetId: "94000000-0000-4000-8000-000000000003",
        kind: "IMAGE",
        status: "PROCESSING",
      },
    ]);
    const query = sql.queries.join("\n");
    expect(query).toMatch(/account_state = 'ACTIVE'/u);
    expect(query).toMatch(/provenance_entity_type = 'JOB_REQUEST'/u);
    expect(query).toMatch(/LIMIT 139/u);
    expect(query).not.toMatch(/storage_key|display_filename/iu);
  });

  it("locks the active owner and exact current draft before minting provenance", async () => {
    const sql = scriptedSql([
      [{ id: "94000000-0000-4000-8000-000000000004" }],
      [{ id: jobRequestId }],
      [{ revision: 7, state: "DRAFT" }],
    ]);
    await expect(
      createJobRequestMediaUploadAuthorization(sql).prepareUpload({
        actorUserId,
        expectedRevision: 7,
        jobRequestId,
        mediaKind: "DOCUMENT",
      }),
    ).resolves.toMatchObject({
      provenance: {
        entityId: jobRequestId,
        entityRevision: 7,
        entityType: "JOB_REQUEST",
      },
      purpose: "JOB_REQUEST_DOCUMENT",
      status: "AUTHORIZED",
    });
    expect(sql.queries.join("\n")).toMatch(
      /account_state = 'ACTIVE'[\s\S]*FOR UPDATE OF actor, customer[\s\S]*customer_profile_id[\s\S]*FOR UPDATE[\s\S]*ORDER BY revision DESC[\s\S]*FOR UPDATE/u,
    );
  });

  it("fails closed for foreign, stale, active, or malformed requests", async () => {
    const foreign = scriptedSql([[]]);
    await expect(
      createJobRequestMediaUploadAuthorization(foreign).prepareUpload({
        actorUserId,
        expectedRevision: 1,
        jobRequestId,
        mediaKind: "IMAGE",
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(foreign.queries).toHaveLength(1);

    const active = scriptedSql([
      [{ id: "94000000-0000-4000-8000-000000000004" }],
      [{ id: jobRequestId }],
      [{ revision: 2, state: "ACTIVE" }],
    ]);
    await expect(
      createJobRequestMediaUploadAuthorization(active).prepareUpload({
        actorUserId,
        expectedRevision: 2,
        jobRequestId,
        mediaKind: "IMAGE",
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });

    const invalid = scriptedSql([]);
    await expect(
      createJobRequestMediaUploadAuthorization(invalid).prepareUpload({
        actorUserId,
        expectedRevision: 0,
        jobRequestId,
        mediaKind: "IMAGE",
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(invalid.queries).toHaveLength(0);
  });
});

describe("job request media delivery authorization", () => {
  it("grants only an ACTIVE provider whose exact entitled snapshot selected the asset", async () => {
    const sql = scriptedSql([
      [
        {
          contentRevision: 3,
          grant: "INVITED_PROVIDER",
          relationId: "94000000-0000-4000-8000-000000000005",
          relationRevision: 2,
        },
      ],
    ]);
    const access =
      await createJobRequestMediaAccessResolver(sql).resolvePrivateMediaAccess(
        deliverySnapshot(),
      );
    expect(access.grants).toEqual(["INVITED_PROVIDER"]);
    expect(access.revision).toMatch(/^job-request:[0-9a-f]{64}$/u);
    const query = sql.queries.join("\n");
    expect(query).toMatch(/actor\.account_state = 'ACTIVE'/u);
    expect(query).toMatch(/'JOB_CUSTOMER'::text/u);
    expect(query).toMatch(/job_request_material_update_entitlements/u);
    expect(query).toMatch(/job_request_active_section_revisions/u);
    expect(query).toMatch(/jsonb_array_elements_text/u);
    expect(query).not.toMatch(/storage_key|content_sha256/iu);
  });

  it("grants the ACTIVE customer owner without exposing provider-only history", async () => {
    const sql = scriptedSql([
      [
        {
          contentRevision: 7,
          grant: "JOB_CUSTOMER",
          relationId: jobRequestId,
          relationRevision: 7,
        },
      ],
    ]);
    await expect(
      createJobRequestMediaAccessResolver(sql).resolvePrivateMediaAccess({
        ...deliverySnapshot(),
        asset: {
          ...deliverySnapshot().asset,
          ownerUserId: actorUserId as never,
        },
      }),
    ).resolves.toMatchObject({ grants: ["JOB_CUSTOMER"] });
    const query = sql.queries.join("\n");
    expect(query).toMatch(/customer\.owner_user_id = actor\.id/u);
    expect(query).toMatch(/actor\.id = \?/u);
  });

  it("denies wrong provenance, absent entitlement, and corrupt rows", async () => {
    const wrong = scriptedSql([]);
    await expect(
      createJobRequestMediaAccessResolver(wrong).resolvePrivateMediaAccess({
        ...deliverySnapshot(),
        asset: { ...deliverySnapshot().asset, provenanceEntityType: "JOB" },
      }),
    ).resolves.toMatchObject({ grants: [] });
    expect(wrong.queries).toHaveLength(0);

    await expect(
      createJobRequestMediaAccessResolver(
        scriptedSql([[]]),
      ).resolvePrivateMediaAccess(deliverySnapshot()),
    ).resolves.toMatchObject({ grants: [] });

    await expect(
      createJobRequestMediaAccessResolver(
        scriptedSql([
          [
            {
              contentRevision: 0,
              grant: "UNKNOWN",
              relationId: "invalid",
              relationRevision: 0,
            },
          ],
        ]),
      ).resolvePrivateMediaAccess(deliverySnapshot()),
    ).rejects.toThrow(/invalid/u);
  });
});

function deliverySnapshot() {
  const now = new Date("2026-09-15T20:00:00.000Z");
  return {
    actor: { accountState: "ACTIVE" as const, userId: actorUserId as never },
    asset: {
      id: "94000000-0000-4000-8000-000000000003",
      ownerUserId: "94000000-0000-4000-8000-000000000004" as never,
      provenanceEntityId: jobRequestId,
      provenanceEntityRevision: 7,
      provenanceEntityType: "JOB_REQUEST" as const,
      purpose: "JOB_REQUEST_IMAGE" as const,
      status: "READY" as const,
      updatedAt: now,
    },
    object: {
      contentType: "image/webp",
      createdAt: now,
      id: "94000000-0000-4000-8000-000000000006",
      revokedAt: null,
      role: "CANONICAL" as const,
      storageObject: {
        area: "private" as const,
        key: "private/2026/09/94000000-0000-4000-8000-000000000007" as never,
      },
    },
  };
}

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
    queries,
  });
  return tagged;
}
