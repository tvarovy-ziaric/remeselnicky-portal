import { createServerMediaProvenance } from "@portal/media";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { CredentialClaimRepository } from "../src/credential-claim-repository.js";
import {
  createCredentialEvidenceUploadAuthorization,
  createCredentialTypeReadRepository,
} from "../src/credential-evidence-upload-repository.js";

const actorUserId = "94200000-0000-4000-8000-000000000001";
const craftsmanProfileId = "94200000-0000-4000-8000-000000000002";
const claimId = "94200000-0000-4000-8000-000000000003";
const assetId = "94200000-0000-4000-8000-000000000004";

describe("credential evidence upload repository", () => {
  it("returns only exact owner-scoped status without storage metadata", async () => {
    const sql = scriptedSql([
      [{ assetId, kind: "DOCUMENT", status: "READY", storageKey: "hidden" }],
    ]);
    const result = await createCredentialEvidenceUploadAuthorization(
      sql,
      claimRepository(),
    ).listOwnedUploads({ actorUserId, claimId, craftsmanProfileId });

    expect(result).toEqual([{ assetId, kind: "DOCUMENT", status: "READY" }]);
    expect(JSON.stringify(result)).not.toMatch(/storage|filename|sha256/iu);
    expect(sql.queries.join("\n")).toMatch(
      /actor\.account_state = 'ACTIVE'[\s\S]*profile\.id = [\s\S]*claim\.id =/u,
    );
    expect(sql.queries.join("\n")).toMatch(
      /provenance_entity_type = 'CREDENTIAL'/u,
    );
  });

  it("maps only credential-purpose pending claim authorization", async () => {
    const prepareEvidenceUpload = vi.fn(() =>
      Promise.resolve({
        provenance: createServerMediaProvenance({
          entityId: claimId,
          entityRevision: 2,
          entityType: "CREDENTIAL",
        }),
        purpose: "CREDENTIAL_IMAGE" as const,
        status: "READY" as const,
      }),
    );
    const repository = createCredentialEvidenceUploadAuthorization(
      scriptedSql([]),
      claimRepository(prepareEvidenceUpload),
    );

    await expect(
      repository.prepareUpload({
        actorUserId,
        claimId,
        craftsmanProfileId,
        expectedRevision: 2,
        mediaKind: "IMAGE",
      }),
    ).resolves.toMatchObject({
      purpose: "CREDENTIAL_IMAGE",
      status: "AUTHORIZED",
    });
    expect(prepareEvidenceUpload).toHaveBeenCalledWith({
      actorUserId,
      claimId,
      craftsmanProfileId,
      expectedRevision: 2,
      mediaKind: "IMAGE",
    });
  });

  it("lists only active server-governed type fields", async () => {
    const sql = scriptedSql([
      [
        {
          code: "test.required-license",
          evidenceRequirement: "REQUIRED",
          sourceReference: "must-not-leak",
        },
      ],
    ]);

    await expect(
      createCredentialTypeReadRepository(sql).listActive(),
    ).resolves.toEqual([
      { code: "test.required-license", evidenceRequirement: "REQUIRED" },
    ]);
    expect(sql.queries.join("\n")).toMatch(/WHERE active = true/u);
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
  Object.assign(tagged, { queries });
  return tagged;
}

function claimRepository(
  prepareEvidenceUpload: CredentialClaimRepository["prepareEvidenceUpload"] = vi.fn(
    () => Promise.resolve({ status: "CLAIM_UNAVAILABLE" as const }),
  ),
): CredentialClaimRepository {
  return {
    attachEvidence: vi.fn(),
    create: vi.fn(),
    listOwned: vi.fn(),
    listPendingAuthorized: vi.fn(),
    prepareEvidenceUpload,
    reviewAuthorized: vi.fn(),
  };
}
