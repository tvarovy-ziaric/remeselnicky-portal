import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createPublicSearchCardLoader } from "./public-search-card-client";
import {
  PublicSearchCardList,
  type PublicSearchCardViewModel,
} from "./public-search-card-view";

const profileId = "99000000-0000-4000-8000-000000000001";

describe("public search cards web boundary", () => {
  it("renders an accessible card without inventing absent rating or work", () => {
    const html = renderToStaticMarkup(
      <PublicSearchCardList cards={[card()]} />,
    );
    expect(html).toContain('aria-label="Výsledky vyhľadávania"');
    expect(html).toContain("Majster Ján");
    expect(html).toContain("Prečo sa zhoduje");
    expect(html).not.toMatch(/Hodnotenie|Overené realizácie|email|telefón/iu);
  });

  it("loads with no-store and fails closed on malformed outward data", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [card()], nextCursor: null }), {
          status: 200,
        }),
      ),
    );
    const loader = createPublicSearchCardLoader({
      apiOrigin: "http://api:3001",
      fetch: fetcher,
    });
    await expect(
      loader({ professionCode: "PROF:TILER", skillCodes: ["SKILL:CUT"] }),
    ).resolves.toMatchObject({ items: [{ profileId }] });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ cache: "no-store" }),
    );

    const malformed = createPublicSearchCardLoader({
      apiOrigin: "http://api:3001",
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ ...card(), identity: { primaryName: null } }],
              nextCursor: null,
            }),
          ),
        ),
    });
    await expect(
      malformed({ professionCode: "PROF:TILER" }),
    ).resolves.toBeNull();
  });
});

function card(): PublicSearchCardViewModel & {
  readonly indicativePrice: null;
} {
  return {
    availability: "NO_POSITIVE_SIGNAL",
    badges: [],
    identity: { primaryName: "Majster Ján", secondaryName: "Ján Remeselný" },
    indicativePrice: null,
    location: { approximateDistanceKm: 8, municipalityName: "Bratislava" },
    professions: [{ kind: "PROF:TILER", label: "Obkladač" }],
    profileId,
    rating: { reviewCount: 0, score: null },
    representativePortfolioImage: null,
    verifiedWorkCount: 0,
    whyMatched: [{ kind: "PROFESSION", text: "Vykonáva profesiu Obkladač" }],
  };
}
