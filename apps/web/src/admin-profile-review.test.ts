import { describe, expect, it, vi } from "vitest";

import {
  decideAdminProfileReview,
  loadAdminProfileReviewQueue,
  parseAdminProfileReviewPage,
} from "./admin-profile-review";

const profileId = "94000000-0000-4000-8000-000000000001";
const commandId = "94000000-0000-4000-8000-000000000002";
const correlationId = "94000000-0000-4000-8000-000000000003";
const item = {
  about: "Elektrikárske práce v Bratislavskom kraji.",
  baseMunicipality: { code: "SK0101528595", name: "Bratislava" },
  identity: {
    primaryName: "Ján Novák",
    profileType: "INDIVIDUAL",
    secondaryName: "Jano",
  },
  normalRadiusMeters: 25_000,
  professions: [
    {
      code: "PROF:ELECTRICIAN",
      declaredLevel: "ADVANCED",
      label: "Elektrikár",
    },
  ],
  profileId,
  publicationRevision: 3,
  readiness: { isReady: true, missing: [] },
  submittedAt: "2026-09-28T09:00:00.000Z",
};

describe("admin profile review client", () => {
  it("accepts only the bounded privacy-minimal review page", () => {
    expect(
      parseAdminProfileReviewPage({ items: [item], nextCursor: null }),
    ).toEqual({ items: [item], nextCursor: null });
    expect(
      parseAdminProfileReviewPage({
        items: [{ ...item, ownerUserId: "private" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseAdminProfileReviewPage({
        items: [
          {
            ...item,
            identity: { ...item.identity, email: "private@example.test" },
          },
        ],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseAdminProfileReviewPage({
        items: [
          {
            ...item,
            readiness: { isReady: true, missing: ["ABOUT"] },
          },
        ],
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("loads the privileged queue without caching", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ items: [item], nextCursor: null }));
    await expect(
      loadAdminProfileReviewQueue(undefined, fetcher),
    ).resolves.toEqual({
      page: { items: [item], nextCursor: null },
      status: "OK",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/admin/craftsman-profiles/review-queue?limit=20",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("sends approve decisions with CSRF and exact idempotency data", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-admin-token" }))
      .mockResolvedValueOnce(
        Response.json({
          publication: {
            profileId,
            revision: 4,
            reviewState: "APPROVED",
          },
          status: "APPLIED",
        }),
      );
    await expect(
      decideAdminProfileReview({
        action: "approve",
        commandId,
        correlationId,
        expectedRevision: 3,
        fetch: fetcher,
        profileId,
        reason: "Profil spĺňa požiadavky na zverejnenie.",
      }),
    ).resolves.toBe("OK");
    const [path, options] = fetcher.mock.calls[1] ?? [];
    expect(path).toBe("/v1/admin/craftsman-profiles/" + profileId + "/approve");
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe(
      "csrf-admin-token",
    );
    expect(typeof options?.body).toBe("string");
    expect(JSON.parse(options?.body as string)).toEqual({
      commandId,
      correlationId,
      expectedRevision: 3,
      reason: "Profil spĺňa požiadavky na zverejnenie.",
    });
  });

  it("fails closed on leaked CSRF and stale decisions", async () => {
    const leaked = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ csrfToken: "csrf-admin-token", userId: "private" }),
      );
    await expect(
      decideAdminProfileReview({
        action: "reject",
        commandId,
        correlationId,
        expectedRevision: 3,
        fetch: leaked,
        profileId,
        reason: "Doplňte opis poskytovaných služieb.",
      }),
    ).resolves.toBe("UNAVAILABLE");
    expect(leaked).toHaveBeenCalledTimes(1);

    const stale = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-admin-token" }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(
      decideAdminProfileReview({
        action: "reject",
        commandId,
        correlationId,
        expectedRevision: 3,
        fetch: stale,
        profileId,
        reason: "Doplňte opis poskytovaných služieb.",
      }),
    ).resolves.toBe("STALE");
  });
});
