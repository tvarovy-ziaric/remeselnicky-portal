import { describe, expect, it, vi } from "vitest";

import { loadJobRequestMunicipalitySuggestions } from "./job-request-municipality-client";

describe("job request municipality suggestions", () => {
  it("parses only the coarse governed location allowlist", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        suggestions: [
          {
            code: "SK:BA:BRATISLAVA",
            districtName: "Bratislava I",
            latitude: 48.1,
            name: "Bratislava",
            regionName: "Bratislavský kraj",
          },
        ],
      }),
    );
    await expect(
      loadJobRequestMunicipalitySuggestions("Brat", fetcher),
    ).resolves.toEqual([
      {
        code: "SK:BA:BRATISLAVA",
        districtName: "Bratislava I",
        name: "Bratislava",
        regionName: "Bratislavský kraj",
      },
    ]);
  });

  it("fails closed without a request for short input or corrupt rows", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        suggestions: [
          { code: "bad code", districtName: "D", name: "N", regionName: "R" },
        ],
      }),
    );
    await expect(
      loadJobRequestMunicipalitySuggestions("a", fetcher),
    ).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      loadJobRequestMunicipalitySuggestions("obec", fetcher),
    ).resolves.toEqual([]);
  });
});
