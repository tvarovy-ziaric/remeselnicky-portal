import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanPortfolioClient,
  parseOwnedPortfolioProject,
} from "./craftsman-portfolio-client";

const profileId = "9f330000-0000-4000-8000-000000000001";
const projectId = "9f330000-0000-4000-8000-000000000002";
const professionId = "9f330000-0000-4000-8000-000000000003";
const commandId = "9f330000-0000-4000-8000-000000000004";
const assetId = "9f330000-0000-4000-8000-000000000005";
const attachmentId = "9f330000-0000-4000-8000-000000000006";

describe("craftsman portfolio client", () => {
  it("strictly parses the privacy-minimal self-declared project", () => {
    expect(parseOwnedPortfolioProject(project())).toMatchObject({
      evidenceStatus: "UNVERIFIED",
      id: projectId,
      provenanceKind: "SELF_DECLARED",
    });
    expect(
      parseOwnedPortfolioProject({
        ...project(),
        authorUserId: "9f330000-0000-4000-8000-000000000099",
      }),
    ).toBeNull();
    expect(
      parseOwnedPortfolioProject({ ...project(), storageKey: "private/leak" }),
    ).toBeNull();
  });

  it("loads projects with same-origin no-store and rejects widened responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ projects: [project()] }));
    const result =
      await createCraftsmanPortfolioClient(fetcher).listProjects(profileId);
    expect(result).toMatchObject({ status: "READY" });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/craftsman-profile/${profileId}/portfolio-projects`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );

    const widened = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ projects: [project()], storageBucket: "private" }),
      );
    await expect(
      createCraftsmanPortfolioClient(widened).listProjects(profileId),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("keeps stable command identifiers in the exact create payload", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf" }))
      .mockResolvedValueOnce(
        jsonResponse({ project: project(), status: "APPLIED" }, 201),
      );
    const result = await createCraftsmanPortfolioClient(fetcher).createProject({
      commandId,
      contribution: null,
      portfolioProjectId: projectId,
      professionIds: [professionId],
      profileId,
      shortDescription: "Syntetický bezpečný opis realizácie.",
      title: "Syntetická realizácia",
    });
    expect(result.status).toBe("APPLIED");
    const [, request] = fetcher.mock.calls[1] ?? [];
    const requestBody = request?.body;
    expect(typeof requestBody).toBe("string");
    const parsedBody: unknown =
      typeof requestBody === "string" ? JSON.parse(requestBody) : null;
    expect(parsedBody).toEqual({
      commandId,
      contribution: null,
      portfolioProjectId: projectId,
      professionIds: [professionId],
      shortDescription: "Syntetický bezpečný opis realizácie.",
      title: "Syntetická realizácia",
    });
    expect(request?.headers).toMatchObject({ "x-csrf-token": "csrf" });
  });

  it("uploads image bytes without exposing or persisting the local filename", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf" }))
      .mockResolvedValueOnce(
        jsonResponse({ assetId, kind: "IMAGE", status: "PROCESSING" }, 202),
      );
    const file = new File([new Uint8Array([1, 2, 3])], "customer-home.png", {
      type: "image/png",
    });
    const result = await createCraftsmanPortfolioClient(fetcher).uploadPhoto({
      file,
      profileId,
      projectId,
      projectRevision: 2,
    });
    expect(result).toEqual({
      status: "APPLIED",
      value: { assetId, kind: "IMAGE", status: "PROCESSING" },
    });
    const [, request] = fetcher.mock.calls[1] ?? [];
    expect(request?.body).toBe(file);
    expect(request?.headers).not.toHaveProperty("x-file-name");
    expect(request?.headers).toMatchObject({
      "content-type": "image/png",
      "x-expected-project-revision": "2",
    });
  });

  it("accepts only the exact authenticated photo path and attach envelope", async () => {
    const photoSet = {
      craftsmanProfileId: profileId,
      photos: [
        {
          attachedAt: "2026-09-28T12:00:00.000Z",
          attachmentId,
          canonicalHeight: 900,
          canonicalWidth: 1_200,
          capturedAt: null,
          downloadPath: `/v1/media/${assetId}/download`,
          mediaAssetId: assetId,
          order: 1,
          phase: "AFTER",
          state: "ACTIVE",
        },
      ],
      portfolioProjectId: projectId,
      revision: 1,
      updatedAt: "2026-09-28T12:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf" }))
      .mockResolvedValueOnce(
        jsonResponse({ photoSet, status: "DEDUPLICATED" }),
      );
    const result = await createCraftsmanPortfolioClient(fetcher).attachPhoto({
      attachmentId,
      commandId,
      expectedRevision: 0,
      mediaAssetId: assetId,
      phase: "AFTER",
      profileId,
      projectId,
    });
    expect(result.status).toBe("APPLIED");

    const injected = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        photoSet: {
          ...photoSet,
          photos: [
            {
              ...photoSet.photos[0],
              downloadPath: "https://attacker.invalid/file",
            },
          ],
        },
      }),
    );
    await expect(
      createCraftsmanPortfolioClient(injected).listPhotos(profileId, projectId),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });
});

function project() {
  return {
    contribution: null,
    craftsmanProfileId: profileId,
    createdAt: "2026-09-28T12:00:00.000Z",
    districtCode: null,
    durationUnit: null,
    durationValue: null,
    evidenceStatus: "UNVERIFIED",
    id: projectId,
    indicativePriceMaxCents: null,
    indicativePriceMinCents: null,
    materialsAndTechnologies: null,
    municipalityCode: null,
    problem: null,
    professionIds: [professionId],
    provenanceKind: "SELF_DECLARED",
    recordState: "DRAFT",
    revision: 1,
    shortDescription: "Syntetický bezpečný opis realizácie.",
    skillIds: [],
    solution: null,
    specializationIds: [],
    title: "Syntetická realizácia",
    updatedAt: "2026-09-28T12:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
