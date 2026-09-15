import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

import { createJobRequestMediaUploadAuthorization } from "../src/job-request-media-repository.js";

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
