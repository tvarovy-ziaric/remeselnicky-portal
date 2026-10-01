import { describe, expect, it, vi } from "vitest";

import {
  buildAdminTaxonomyMapPayload,
  loadAdminTaxonomyCatalog,
  loadAdminTaxonomySuggestionQueue,
  mutateAdminTaxonomy,
} from "./admin-taxonomy-data";

const item = {
  aliases: ["elektrikar"],
  code: "PROF:ELECTRICIAN",
  description: "Elektrické inštalácie a opravy.",
  kind: "PROFESSION",
  name: "Elektrikár",
  primaryProfessionCode: null,
  professionCodes: [],
  releaseVersion: 4,
  replacedByCode: null,
  slug: "elektrikar",
  state: "ACTIVE",
};

describe("admin taxonomy browser client", () => {
  it("adds the proposed name as an alias only after an explicit admin choice", () => {
    const common = {
      adminDecisionNote: "Návrh patrí k existujúcej službe.",
      commandId: "a9900000-0000-4000-8000-000000000003",
      expectedRevision: 1,
      resolvedKind: "SERVICE" as const,
      resolvedTaxonomyCode: "SERV:ELECTRICAL_REPAIR",
    };
    expect(
      buildAdminTaxonomyMapPayload({
        ...common,
        addProposedNameAsAlias: false,
      }),
    ).toMatchObject({ addProposedNameAsAlias: false });
    expect(
      buildAdminTaxonomyMapPayload({
        ...common,
        addProposedNameAsAlias: true,
      }),
    ).toMatchObject({ addProposedNameAsAlias: true });
  });

  it("loads only an exact managed catalog response", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [item] }));
    await expect(
      loadAdminTaxonomyCatalog(
        { kind: "PROFESSION", query: " elektr ", state: "ACTIVE" },
        fetcher,
      ),
    ).resolves.toMatchObject({ data: [item], status: "OK" });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/v1/admin/taxonomy/catalog?limit=300&kind=PROFESSION&state=ACTIVE&query=elektr",
    );
    await expect(
      loadAdminTaxonomyCatalog(
        {},
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ items: [item], requesterEmail: "private" }),
          ),
      ),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("rejects malformed or over-broad suggestion queue payloads", async () => {
    const suggestion = {
      adminDecisionNote: null,
      createdAt: "2026-10-01T09:00:00.000Z",
      decidedAt: null,
      id: "a9900000-0000-4000-8000-000000000002",
      proposedDescription: "Pravidelný servis tepelného čerpadla.",
      proposedName: "Servis tepelného čerpadla",
      requesterCraftsmanProfileId: "a9900000-0000-4000-8000-000000000004",
      resolvedTaxonomyCode: null,
      resolvedTaxonomyLabel: null,
      revision: 1,
      state: "PENDING",
      suggestedKind: "SERVICE",
    };
    await expect(
      loadAdminTaxonomySuggestionQueue(
        vi.fn().mockResolvedValue(Response.json({ items: [suggestion] })),
      ),
    ).resolves.toMatchObject({ data: [suggestion], status: "OK" });
    await expect(
      loadAdminTaxonomySuggestionQueue(
        vi.fn().mockResolvedValue(
          Response.json({
            items: [{ ...suggestion, requesterUserId: "private" }],
          }),
        ),
      ),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("gets CSRF and reports structured alias collisions without retrying a mutation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-admin-token" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            aliasConflicts: [
              {
                alias: "elektro servis",
                conflictingCode: "SERV:ELECTRICAL_REPAIR",
                conflictingKind: "SERVICE",
                conflictingName: "Oprava elektroinštalácie",
              },
            ],
            status: "ALIAS_CONFLICT",
          },
          { status: 409 },
        ),
      );
    await expect(
      mutateAdminTaxonomy(
        "/v1/admin/taxonomy/catalog/PROF%3AELECTRICIAN/edit",
        { commandId: "a9900000-0000-4000-8000-000000000003" },
        fetcher,
      ),
    ).resolves.toEqual({
      conflicts: [
        "elektro servis → Oprava elektroinštalácie (SERV:ELECTRICAL_REPAIR)",
      ],
      status: "ALIAS_CONFLICT",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const options = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(options.headers).get("x-csrf-token")).toBe(
      "csrf-admin-token",
    );
    expect(options.method).toBe("POST");
  });

  it("fails closed for stale MFA, invalid endpoints and response shape", async () => {
    await expect(
      loadAdminTaxonomyCatalog(
        {},
        vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
      ),
    ).resolves.toEqual({ status: "DENIED" });
    await expect(
      mutateAdminTaxonomy("/v1/users/delete", {}, vi.fn()),
    ).resolves.toEqual({ code: "INVALID_PATH", status: "UNAVAILABLE" });
  });
});
