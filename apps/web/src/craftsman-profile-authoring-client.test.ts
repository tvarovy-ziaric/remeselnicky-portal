import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanProfileAuthoringClient,
  parseCraftsmanAuthoringAggregate,
} from "./craftsman-profile-authoring-client";
import {
  deriveReadiness,
  serviceProfessionIdsForSuggestion,
} from "./craftsman-profile-authoring";

const profileId = "93000000-0000-4000-8000-000000000001";
const professionId = "93000000-0000-4000-8000-000000000002";
const commandId = "93000000-0000-4000-8000-000000000003";

const aggregate = {
  profile: {
    id: profileId,
    profileType: "INDIVIDUAL",
    about: "Spoľahlivý elektrikár s praxou.",
    revision: 1,
    createdAt: "2026-09-28T08:00:00.000Z",
    updatedAt: "2026-09-28T08:00:00.000Z",
    identityVerified: false,
    realFirstName: "Ján",
    realLastName: "Novák",
    nickname: "Jano",
  },
  professions: [
    {
      id: professionId,
      professionCode: "PROF:ELECTRICIAN",
      taxonomyLabel: "Elektrikár",
      state: "ACTIVE",
      declaredLevel: "ADVANCED",
      declaredLevelRevision: 1,
      evidenceSupportedLevel: null,
      createdAt: "2026-09-28T08:05:00.000Z",
      deactivatedAt: null,
    },
  ],
  services: [
    {
      craftsmanProfessionIds: [professionId],
      createdAt: "2026-09-28T08:06:00.000Z",
      deactivatedAt: null,
      id: "93000000-0000-4000-8000-000000000004",
      serviceCode: "SERV:SOCKET_INSTALLATION",
      taxonomyLabel: "Montáž zásuviek",
      state: "ACTIVE",
    },
  ],
  serviceArea: {
    revision: 1,
    baseMunicipalityCode: "SK0101528595",
    normalRadiusKm: 25,
    maximumRadiusKm: null,
    extraMunicipalityCodes: [],
    travelFeePolicy: null,
    travelFeeThresholdKm: null,
    createdAt: "2026-09-28T08:10:00.000Z",
  },
  publication: {
    revision: 2,
    reviewState: "PENDING",
    ownerVisibility: "HIDDEN",
    moderationState: "ALLOWED",
    effectivelyPublic: false,
    readiness: { isReady: true, missing: [] },
    approvedAt: null,
    rejection: null,
    changedAt: "2026-09-28T08:15:00.000Z",
  },
};

describe("craftsman profile authoring client", () => {
  it("accepts only the exact private owner aggregate", () => {
    expect(parseCraftsmanAuthoringAggregate(aggregate)).toEqual(aggregate);
    expect(
      parseCraftsmanAuthoringAggregate({
        ...aggregate,
        profile: { ...aggregate.profile, ownerUserId: "private" },
      }),
    ).toBeNull();
    expect(
      parseCraftsmanAuthoringAggregate({
        ...aggregate,
        publication: {
          ...aggregate.publication,
          reviewerUserId: "private",
        },
      }),
    ).toBeNull();
    expect(
      parseCraftsmanAuthoringAggregate({
        ...aggregate,
        serviceArea: {
          ...aggregate.serviceArea,
          exactAddress: "private",
        },
      }),
    ).toBeNull();
  });

  it("derives the locked first-submission minimum before publication exists", () => {
    const ready = parseCraftsmanAuthoringAggregate({
      ...aggregate,
      profile: { ...aggregate.profile, identityVerified: true },
      publication: null,
    });
    expect(ready).not.toBeNull();
    expect(deriveReadiness(ready!)).toEqual([]);

    const incomplete = parseCraftsmanAuthoringAggregate({
      ...aggregate,
      profile: { ...aggregate.profile, about: null, identityVerified: false },
      professions: [],
      publication: null,
      serviceArea: null,
    });
    expect(incomplete).not.toBeNull();
    expect(deriveReadiness(incomplete!)).toEqual([
      "VALID_IDENTITY",
      "ABOUT",
      "ACTIVE_PROFESSION_WITH_DECLARED_LEVEL",
      "BASE_MUNICIPALITY",
      "NORMAL_RADIUS",
    ]);
  });

  it("maps private-load authentication states and rejects malformed payloads", async () => {
    const authenticated = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(aggregate));
    await expect(
      createCraftsmanProfileAuthoringClient(authenticated).load(),
    ).resolves.toEqual({ aggregate, status: "READY" });
    expect(authenticated).toHaveBeenCalledWith(
      "/v1/me/craftsman-profile",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );

    for (const [status, expected] of [
      [401, "AUTHENTICATION_REQUIRED"],
      [403, "ACCOUNT_NOT_ACTIVE"],
      [404, "NOT_FOUND"],
    ] as const) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }));
      await expect(
        createCraftsmanProfileAuthoringClient(fetcher).load(),
      ).resolves.toEqual({ status: expected });
    }

    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...aggregate, email: "leak@test" }));
    await expect(
      createCraftsmanProfileAuthoringClient(malformed).load(),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("uses a same-origin CSRF token and bounded authoring command body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-safe-token" }))
      .mockResolvedValueOnce(
        Response.json({
          profession: aggregate.professions[0],
          status: "APPLIED",
        }),
      );

    await expect(
      createCraftsmanProfileAuthoringClient(fetcher).assignProfession({
        commandId,
        craftsmanProfessionId: professionId,
        declaredLevel: "ADVANCED",
        professionCode: "PROF:ELECTRICIAN",
        profileId,
      }),
    ).resolves.toEqual({ status: "APPLIED" });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/v1/auth/csrf",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
    const [, options] = fetcher.mock.calls[1] ?? [];
    expect(options).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "POST",
    });
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe(
      "csrf-safe-token",
    );
    expect(typeof options?.body).toBe("string");
    expect(JSON.parse(options?.body as string)).toEqual({
      commandId,
      craftsmanProfessionId: professionId,
      declaredLevel: "ADVANCED",
      professionCode: "PROF:ELECTRICIAN",
    });
  });

  it("writes explicit managed service-to-profession assignments", async () => {
    const service = aggregate.services[0]!;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-safe-token" }))
      .mockResolvedValueOnce(Response.json({ service, status: "APPLIED" }));

    await expect(
      createCraftsmanProfileAuthoringClient(fetcher).addService({
        commandId,
        craftsmanProfessionIds: [professionId],
        craftsmanServiceId: service.id,
        profileId,
        serviceCode: service.serviceCode,
      }),
    ).resolves.toEqual({ status: "APPLIED" });
    const [, options] = fetcher.mock.calls[1] ?? [];
    expect(JSON.parse(options?.body as string)).toEqual({
      commandId,
      craftsmanProfessionIds: [professionId],
      craftsmanServiceId: service.id,
      serviceCode: "SERV:SOCKET_INSTALLATION",
    });
  });

  it("links a service only to matching active owned professions", () => {
    const parsed = parseCraftsmanAuthoringAggregate(aggregate);
    expect(parsed).not.toBeNull();
    expect(
      serviceProfessionIdsForSuggestion(
        {
          code: "SERV:SOCKET_INSTALLATION",
          kind: "SERVICE",
          label: "Montáž zásuvky",
          memberCount: 2,
          professionCodes: ["PROF:ELECTRICIAN"],
          routingProfessionCode: "PROF:ELECTRICIAN",
        },
        parsed!,
      ),
    ).toEqual([professionId]);
    expect(
      serviceProfessionIdsForSuggestion(
        {
          code: "SERV:TILE_INSTALLATION",
          kind: "SERVICE",
          label: "Pokládka dlažby",
          memberCount: 3,
          professionCodes: ["PROF:TILER"],
          routingProfessionCode: "PROF:TILER",
        },
        parsed!,
      ),
    ).toEqual([]);
  });

  it("fails closed on leaked CSRF responses and stale commands", async () => {
    const leakedCsrf = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ csrfToken: "csrf-safe-token", userId: "private" }),
      );
    await expect(
      createCraftsmanProfileAuthoringClient(leakedCsrf).submitForReview({
        commandId,
        expectedRevision: 1,
        profileId,
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(leakedCsrf).toHaveBeenCalledTimes(1);

    const stale = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-safe-token" }))
      .mockResolvedValueOnce(
        Response.json({ code: "STALE_STATE" }, { status: 409 }),
      );
    await expect(
      createCraftsmanProfileAuthoringClient(stale).submitForReview({
        commandId,
        expectedRevision: 1,
        profileId,
      }),
    ).resolves.toEqual({ status: "STALE_STATE" });
  });
});
