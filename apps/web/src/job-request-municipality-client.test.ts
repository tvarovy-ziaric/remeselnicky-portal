import { describe, expect, it, vi } from "vitest";

import {
  formatPostalCode,
  isMunicipalityQueryEligible,
  loadJobRequestMunicipalitySuggestions,
} from "./job-request-municipality-client";

describe("job request municipality suggestions", () => {
  it("parses only the coarse governed location allowlist", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        suggestions: [
          {
            code: "SK:BA:BRATISLAVA",
            districtName: "Bratislava I",
            kind: "MUNICIPALITY",
            latitude: 48.1,
            name: "Bratislava",
            postalCodes: ["81101", "85101"],
            regionName: "Bratislavský kraj",
          },
        ],
      }),
    );
    await expect(
      loadJobRequestMunicipalitySuggestions("Brat", fetcher),
    ).resolves.toEqual({
      status: "OK",
      suggestions: [
        {
          code: "SK:BA:BRATISLAVA",
          districtName: "Bratislava I",
          kind: "MUNICIPALITY",
          name: "Bratislava",
          postalCodes: ["81101", "85101"],
          regionName: "Bratislavský kraj",
        },
      ],
    });
  });

  it("accepts a governed whole-city area without a fake district or postal code", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        suggestions: [
          {
            code: "CITY_AREA:BRATISLAVA",
            districtName: null,
            kind: "CITY_AREA",
            name: "Bratislava",
            postalCodes: [],
            regionName: "Bratislavský kraj",
          },
        ],
      }),
    );

    await expect(
      loadJobRequestMunicipalitySuggestions("Brat", fetcher),
    ).resolves.toEqual({
      status: "OK",
      suggestions: [
        {
          code: "CITY_AREA:BRATISLAVA",
          districtName: null,
          kind: "CITY_AREA",
          name: "Bratislava",
          postalCodes: [],
          regionName: "Bratislavský kraj",
        },
      ],
    });
  });

  it("rejects inconsistent whole-city and municipality metadata", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          suggestions: [
            {
              code: "CITY_AREA:BRATISLAVA",
              districtName: "Bratislava I",
              kind: "CITY_AREA",
              name: "Bratislava",
              postalCodes: ["81101"],
              regionName: "Bratislavský kraj",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          suggestions: [
            {
              code: "528595",
              districtName: null,
              kind: "MUNICIPALITY",
              name: "Bratislava-Staré Mesto",
              postalCodes: [],
              regionName: "Bratislavský kraj",
            },
          ],
        }),
      );

    await expect(
      loadJobRequestMunicipalitySuggestions("Brat", fetcher),
    ).resolves.toEqual({ status: "ERROR", suggestions: [] });
    await expect(
      loadJobRequestMunicipalitySuggestions("Brati", fetcher),
    ).resolves.toEqual({ status: "ERROR", suggestions: [] });
  });

  it("distinguishes an invalid payload from a valid zero result", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        suggestions: [
          { code: "bad code", districtName: "D", name: "N", regionName: "R" },
        ],
      }),
    );
    await expect(
      loadJobRequestMunicipalitySuggestions("a", fetcher),
    ).resolves.toEqual({ status: "ZERO", suggestions: [] });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      loadJobRequestMunicipalitySuggestions("obec", fetcher),
    ).resolves.toEqual({ status: "ERROR", suggestions: [] });
  });

  it("reports an unavailable service separately from no matches", async () => {
    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      loadJobRequestMunicipalitySuggestions("Prie", unavailable),
    ).resolves.toEqual({ status: "ERROR", suggestions: [] });

    const empty = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ suggestions: [] }));
    await expect(
      loadJobRequestMunicipalitySuggestions("Nenájdená", empty),
    ).resolves.toEqual({ status: "ZERO", suggestions: [] });
  });

  it("starts postal lookup at three digits and preserves user input", async () => {
    expect(isMunicipalityQueryEligible("97")).toBe(false);
    expect(isMunicipalityQueryEligible("971")).toBe(true);
    expect(isMunicipalityQueryEligible("97101")).toBe(true);
    expect(isMunicipalityQueryEligible("971 01")).toBe(true);
    expect(isMunicipalityQueryEligible("971012")).toBe(false);

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ suggestions: [] }));
    await loadJobRequestMunicipalitySuggestions("971 01", fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/public/municipalities/suggestions?q=971+01",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("formats canonical postal codes without converting them to numbers", () => {
    expect(formatPostalCode("97101")).toBe("971 01");
    expect(formatPostalCode("01001")).toBe("010 01");
  });
});
