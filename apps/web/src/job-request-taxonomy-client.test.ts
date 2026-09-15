import { describe, expect, it, vi } from "vitest";

import { loadJobRequestTaxonomySuggestions } from "./job-request-taxonomy-client";

describe("job request taxonomy suggestions", () => {
  it("returns only bounded governed public suggestion fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        suggestions: [
          {
            code: "SPEC:ROOF_REPAIR",
            kind: "SPECIALIZATION",
            label: "Oprava strechy",
            matchedBy: "PREFIX_CANONICAL",
            privateRank: 1,
            professionCodes: ["PROF:ROOFER"],
          },
        ],
      }),
    );

    await expect(
      loadJobRequestTaxonomySuggestions("strecha", fetcher),
    ).resolves.toEqual([
      {
        code: "SPEC:ROOF_REPAIR",
        kind: "SPECIALIZATION",
        label: "Oprava strechy",
        professionCodes: ["PROF:ROOFER"],
      },
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/v1/public/taxonomy/suggestions?q=strecha&limit=8",
    );
  });

  it("does not call the API for an empty query and fails closed on corrupt output", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          suggestions: [
            {
              code: "PROF:BAD",
              kind: "PROFESSION",
              label: "Kontakt test@example.test",
              professionCodes: [],
            },
          ],
        }),
      );
    await expect(
      loadJobRequestTaxonomySuggestions(" ", fetcher),
    ).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      loadJobRequestTaxonomySuggestions("oprava", fetcher),
    ).resolves.toEqual([]);
  });
});
