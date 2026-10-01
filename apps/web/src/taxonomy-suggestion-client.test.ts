import { describe, expect, it, vi } from "vitest";

import {
  createTaxonomySuggestionClient,
  parseOwnedTaxonomySuggestionResponse,
} from "./taxonomy-suggestion-client";

const profileId = "94000000-0000-4000-8000-000000000001";
const commandId = "94000000-0000-4000-8000-000000000002";
const suggestionId = "94000000-0000-4000-8000-000000000003";
const suggestion = {
  adminDecisionNote: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  decidedAt: null,
  id: suggestionId,
  proposedDescription: "Montáž a servis inteligentných zásuviek.",
  proposedName: "Montáž inteligentnej zásuvky",
  resolvedTaxonomyCode: null,
  resolvedTaxonomyLabel: null,
  revision: 1,
  state: "PENDING",
  suggestedKind: "SERVICE",
} as const;

describe("taxonomy suggestion client", () => {
  it("loads only the owner-safe suggestion detail without CSRF or cache", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ suggestion }));
    await expect(
      createTaxonomySuggestionClient(fetcher).load(suggestionId),
    ).resolves.toEqual({ status: "READY", suggestion });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/taxonomy-suggestions/${suggestionId}`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("submits a bounded same-origin owner command with CSRF protection", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        Response.json({ status: "APPLIED", suggestion }, { status: 201 }),
      );
    await expect(
      createTaxonomySuggestionClient(fetcher).submit({
        commandId,
        profileId,
        proposedDescription: suggestion.proposedDescription,
        proposedName: suggestion.proposedName,
        suggestedKind: "SERVICE",
        suggestionId,
      }),
    ).resolves.toEqual({ status: "APPLIED", suggestion });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/v1/auth/csrf",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const [url, options] = fetcher.mock.calls[1] ?? [];
    expect(url).toBe(
      `/v1/me/craftsman-profiles/${profileId}/taxonomy-suggestions`,
    );
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe(
      "csrf-token",
    );
    expect(JSON.parse(options?.body as string)).toEqual({
      commandId,
      proposedDescription: suggestion.proposedDescription,
      proposedName: suggestion.proposedName,
      suggestedKind: "SERVICE",
      suggestionId,
    });
  });

  it("fails closed on extra owner response data and maps duplicate pending", async () => {
    expect(
      parseOwnedTaxonomySuggestionResponse({
        status: "APPLIED",
        suggestion: { ...suggestion, requesterUserId: "private" },
      }),
    ).toBeNull();

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        Response.json({ code: "DUPLICATE_PENDING" }, { status: 409 }),
      );
    await expect(
      createTaxonomySuggestionClient(fetcher).submit({
        commandId,
        profileId,
        proposedDescription: suggestion.proposedDescription,
        proposedName: suggestion.proposedName,
        suggestedKind: null,
        suggestionId,
      }),
    ).resolves.toEqual({ status: "DUPLICATE_PENDING" });
  });
});
