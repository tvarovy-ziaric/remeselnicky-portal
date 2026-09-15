import { describe, expect, it, vi } from "vitest";

import { createJobRequestDraftClient } from "./job-request-draft-client";

const csrfToken = "csrf-token";
const draftId = "97000000-0000-4000-8000-000000000111";
const commandId = "97000000-0000-4000-8000-000000000112";

describe("job request draft client", () => {
  it("loads and validates the latest recoverable draft", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(Response.json({ drafts: [{ id: draftId }] }))
      .mockResolvedValueOnce(
        Response.json({
          draft: {
            id: draftId,
            revision: 2,
            sections: [
              {
                key: "request.core",
                payload: core("Opraviť poškodenú strechu"),
                schemaVersion: 1,
              },
            ],
          },
        }),
      );

    await expect(
      createJobRequestDraftClient({ fetch: fetcher }).load(),
    ).resolves.toMatchObject({
      csrfToken,
      draft: { id: draftId, revision: 2 },
      status: "READY",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fails closed on malformed recovered content", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(Response.json({ drafts: [{ id: draftId }] }))
      .mockResolvedValueOnce(
        Response.json({
          draft: {
            id: draftId,
            revision: 2,
            sections: [
              { key: "request.secret", payload: {}, schemaVersion: 1 },
            ],
          },
        }),
      );

    await expect(
      createJobRequestDraftClient({ fetch: fetcher }).load(),
    ).resolves.toEqual({
      status: "UNAVAILABLE",
    });
  });

  it("creates from the first core section and sends CSRF", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { id: draftId, revision: 1, status: "APPLIED" },
          { status: 201 },
        ),
      );
    const client = createJobRequestDraftClient({
      commandId: () => commandId,
      fetch: fetcher,
    });

    await expect(
      client.save(
        null,
        {
          key: "request.core",
          payload: core("Vymaľovať dve izby"),
          schemaVersion: 1,
        },
        csrfToken,
      ),
    ).resolves.toEqual({ id: draftId, revision: 1, status: "SAVED" });
    const [, options] = fetcher.mock.calls[0] ?? [];
    expect(options?.headers).toMatchObject({ "x-csrf-token": csrfToken });
    expect(typeof options?.body).toBe("string");
    expect(JSON.parse(options?.body as string)).not.toHaveProperty(
      "customerProfileId",
    );
  });

  it("preserves the authoritative revision on a stale write", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "STALE_REVISION", currentRevision: 7 },
          { status: 409 },
        ),
      );
    const client = createJobRequestDraftClient({
      commandId: () => commandId,
      fetch: fetcher,
    });

    await expect(
      client.save(
        { id: draftId, revision: 2, sections: [] },
        { key: "request.core", payload: core("Nový text"), schemaVersion: 1 },
        csrfToken,
      ),
    ).resolves.toEqual({ currentRevision: 7, status: "STALE_REVISION" });
  });

  it("surfaces submission requirements without losing the draft", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "NOT_READY", missingRequirements: ["MUNICIPALITY"] },
          { status: 422 },
        ),
      );
    const client = createJobRequestDraftClient({
      commandId: () => commandId,
      fetch: fetcher,
    });

    await expect(
      client.activate({ id: draftId, revision: 3, sections: [] }, csrfToken),
    ).resolves.toEqual({
      missingRequirements: ["MUNICIPALITY"],
      status: "NOT_READY",
    });
  });

  it("reuses the same command after an ambiguous network failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(
        Response.json({ id: draftId, revision: 4, status: "DEDUPLICATED" }),
      );
    const ids = [commandId, "97000000-0000-4000-8000-000000000113"];
    const client = createJobRequestDraftClient({
      commandId: () => ids.shift() ?? commandId,
      fetch: fetcher,
    });
    const draft = { id: draftId, revision: 3, sections: [] } as const;

    await expect(client.activate(draft, csrfToken)).resolves.toEqual({
      status: "UNAVAILABLE",
    });
    await expect(client.activate(draft, csrfToken)).resolves.toEqual({
      id: draftId,
      revision: 4,
      status: "ACTIVE",
    });
    const firstBody = JSON.parse(
      fetcher.mock.calls[0]?.[1]?.body as string,
    ) as { commandId: string };
    const secondBody = JSON.parse(
      fetcher.mock.calls[1]?.[1]?.body as string,
    ) as { commandId: string };
    expect(firstBody.commandId).toBe(commandId);
    expect(secondBody.commandId).toBe(commandId);
  });

  it("uploads binary media without filename metadata and validates status polling", async () => {
    const assetId = "97000000-0000-4000-8000-000000000114";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { assetId, kind: "IMAGE", status: "PROCESSING" },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          uploads: [{ assetId, kind: "IMAGE", status: "READY" }],
        }),
      );
    const client = createJobRequestDraftClient({ fetch: fetcher });
    const draft = { id: draftId, revision: 3, sections: [] } as const;
    const file = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
      type: "image/jpeg",
    });
    await expect(
      client.uploadMedia(draft, file, "IMAGE", csrfToken),
    ).resolves.toEqual({
      asset: { assetId, kind: "IMAGE", status: "PROCESSING" },
      status: "PROCESSING",
    });
    const [, uploadOptions] = fetcher.mock.calls[0] ?? [];
    expect(uploadOptions?.body).toBe(file);
    expect(uploadOptions?.headers).toMatchObject({
      "content-type": "image/jpeg",
      "x-csrf-token": csrfToken,
      "x-job-request-revision": "3",
    });
    expect(JSON.stringify(uploadOptions?.headers)).not.toMatch(/filename/iu);
    await expect(client.listMedia(draft)).resolves.toEqual({
      status: "OK",
      uploads: [{ assetId, kind: "IMAGE", status: "READY" }],
    });
  });
});

function core(description: string) {
  return {
    description,
    primaryProfessionCode: null,
    relatedProfessionCodes: [],
    skillCodes: [],
    specializationCode: null,
    title: null,
  };
}
