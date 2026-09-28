import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanCredentialClient,
  type OwnedCredentialClaim,
} from "./craftsman-credential-client";

const profileId = "94400000-0000-4000-8000-000000000001";
const professionId = "94400000-0000-4000-8000-000000000002";
const claimId = "94400000-0000-4000-8000-000000000003";
const commandId = "94400000-0000-4000-8000-000000000004";
const assetId = "94400000-0000-4000-8000-000000000005";

describe("craftsman credential client", () => {
  it("strictly loads governed types and the exact private owner projection", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          credentialTypes: [
            {
              code: "test.required-license",
              evidenceRequirement: "REQUIRED",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ credentials: [claim()] }));
    const result =
      await createCraftsmanCredentialClient(fetcher).load(profileId);

    expect(result).toMatchObject({ status: "READY" });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      `/v1/me/craftsman-profile/${profileId}/credential-types`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/v1/me/craftsman-profile/${profileId}/credentials`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );

    const widened = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ credentialTypes: [], sourceReference: "private" }),
      )
      .mockResolvedValueOnce(jsonResponse({ credentials: [claim()] }));
    await expect(
      createCraftsmanCredentialClient(widened).load(profileId),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("rejects foreign profile claims and duplicate evidence identifiers", async () => {
    const foreign = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ credentialTypes: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          credentials: [
            claim({
              craftsmanProfileId: "94400000-0000-4000-8000-000000000099",
            }),
          ],
        }),
      );
    await expect(
      createCraftsmanCredentialClient(foreign).load(profileId),
    ).resolves.toEqual({ status: "UNAVAILABLE" });

    const duplicated = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ credentialTypes: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          credentials: [
            claim({
              evidence: [evidence(), evidence()],
            }),
          ],
        }),
      );
    await expect(
      createCraftsmanCredentialClient(duplicated).load(profileId),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("does not make a valid owner history unavailable at an arbitrary client count", async () => {
    const credentials = Array.from({ length: 129 }, (_item, index) =>
      claim({
        id: `94400000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ credentialTypes: [] }))
      .mockResolvedValueOnce(jsonResponse({ credentials }));

    await expect(
      createCraftsmanCredentialClient(fetcher).load(profileId),
    ).resolves.toMatchObject({
      status: "READY",
      value: { credentials },
    });
  });

  it("reuses claim and command identifiers after an ambiguous create failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token-value" }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token-value" }))
      .mockResolvedValueOnce(
        jsonResponse({ claim: claim(), status: "APPLIED" }, 201),
      );
    const ids = [claimId, commandId];
    const client = createCraftsmanCredentialClient(fetcher, () => ids.shift()!);
    const input = {
      craftsmanProfessionId: professionId,
      credentialTypeCode: "test.required-license",
      expiresOn: null,
      profileId,
    };
    await expect(client.createClaim(input)).resolves.toEqual({
      status: "UNAVAILABLE",
    });
    await expect(client.createClaim(input)).resolves.toMatchObject({
      status: "APPLIED",
    });
    const firstBody = fetcher.mock.calls[1]?.[1]?.body;
    const secondBody = fetcher.mock.calls[3]?.[1]?.body;
    expect(firstBody).toBe(secondBody);
    expect(typeof secondBody).toBe("string");
    expect(
      JSON.parse(typeof secondBody === "string" ? secondBody : "null"),
    ).toEqual({
      claimId,
      commandId,
      craftsmanProfessionId: professionId,
      credentialTypeCode: "test.required-license",
      expiresOn: null,
    });
  });

  it("uploads raw supported bytes and attaches READY evidence only", async () => {
    const uploadFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token-value" }))
      .mockResolvedValueOnce(
        jsonResponse({ assetId, kind: "DOCUMENT", status: "PROCESSING" }, 202),
      );
    const file = new File([new Uint8Array([1, 2, 3])], "private.pdf", {
      type: "application/pdf",
    });
    const client = createCraftsmanCredentialClient(uploadFetcher);
    await expect(
      client.uploadEvidence({
        claim: claim(),
        file,
        mediaKind: "DOCUMENT",
        profileId,
      }),
    ).resolves.toEqual({
      status: "APPLIED",
      value: { assetId, kind: "DOCUMENT", status: "PROCESSING" },
    });
    const [, request] = uploadFetcher.mock.calls[1] ?? [];
    expect(request?.body).toBe(file);
    expect(request?.headers).toMatchObject({
      "content-type": "application/pdf",
      "x-expected-credential-revision": "1",
    });
    expect(request?.headers).not.toHaveProperty("x-file-name");

    await expect(
      client.attachEvidence({
        claim: claim(),
        profileId,
        upload: {
          assetId,
          kind: "DOCUMENT",
          status: "PROCESSING",
        },
      }),
    ).resolves.toEqual({ status: "WRONG_STATE" });
    expect(uploadFetcher).toHaveBeenCalledTimes(2);
  });
});

function evidence() {
  return {
    attachedAt: "2026-09-28T12:00:00.000Z",
    mediaAssetId: assetId,
    mediaKind: "DOCUMENT" as const,
  };
}

function claim(
  overrides: Partial<OwnedCredentialClaim> = {},
): OwnedCredentialClaim {
  return {
    createdAt: "2026-09-28T12:00:00.000Z",
    craftsmanProfessionId: professionId,
    craftsmanProfileId: profileId,
    credentialTypeCode: "test.required-license",
    evidence: [],
    evidenceRequirement: "REQUIRED",
    expiresOn: null,
    id: claimId,
    reviewReason: null,
    reviewReasonCategory: null,
    reviewedAt: null,
    revision: 1,
    state: "PENDING",
    updatedAt: "2026-09-28T12:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}
