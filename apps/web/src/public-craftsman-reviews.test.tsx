import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PublicCraftsmanReviewsPage } from "./public-craftsman-reviews-client";
import {
  formatReviewedMonth,
  PublicCraftsmanReviews,
  PublicProfessionReviewEvidence,
} from "./public-craftsman-reviews";

const profileId = "84000000-0000-4000-8000-000000000001";
const reviewId = "84000000-0000-4000-8000-000000000002";

describe("public craftsman reviews", () => {
  it("renders neutral public evidence without customer or Job identity", () => {
    const html = renderToStaticMarkup(
      <PublicCraftsmanReviews
        page={page()}
        professionLabels={{ "PROF:CARPENTER": "Stolár" }}
        profileId={profileId}
        reviewCount={12}
      />,
    );

    expect(html).toContain("Hodnotenia");
    expect(html).toContain("12 hodnotení od overených zákazníkov");
    expect(html).toContain("Overený zákazník");
    expect(html).toContain("Stolár");
    expect(html).toContain("september 2026");
    expect(html).toContain("4,7 z 5");
    expect(html).toContain("Kvalita práce");
    expect(html).toContain("Dodržanie dohodnutej ceny");
    expect(html).toContain("Dodržanie termínu");
    expect(html).toContain("Komunikácia");
    expect(html).toContain("Čistota a poriadok");
    expect(html).toContain("Riešenie problémov");
    expect(html).toContain("Znovu by si zákazník vybral tohto poskytovateľa");
    expect(html).toContain("Neviem posúdiť / netýka sa");
    expect(html).toContain("Poctivá práca a dobrá komunikácia.");
    expect(html).not.toContain(reviewId);
    expect(html).not.toMatch(/job|customerName|submittedAt|email|adresa/iu);
  });

  it("uses a neutral profession fallback for historical inactive work", () => {
    const html = renderToStaticMarkup(
      <PublicCraftsmanReviews
        page={page()}
        professionLabels={{}}
        profileId={profileId}
        reviewCount={1}
      />,
    );
    expect(html).toContain("Profesia zákazky");
    expect(html).not.toContain("PROF:CARPENTER");
  });

  it("distinguishes a valid empty page from a temporary failure", () => {
    const empty = renderToStaticMarkup(
      <PublicCraftsmanReviews
        page={{ nextCursor: null, reviews: [] }}
        professionLabels={{}}
        profileId={profileId}
        reviewCount={0}
      />,
    );
    const unavailable = renderToStaticMarkup(
      <PublicCraftsmanReviews
        page={null}
        professionLabels={{}}
        profileId={profileId}
        reviewCount={0}
      />,
    );
    expect(empty).toContain("Zatiaľ bez zákazníckych hodnotení");
    expect(unavailable).toContain("Hodnotenia sa momentálne nedajú načítať");
  });

  it("offers only a safely encoded next-page link", () => {
    const html = renderToStaticMarkup(
      <PublicCraftsmanReviews
        page={page()}
        professionLabels={{ "PROF:CARPENTER": "Stolár" }}
        profileId={profileId}
        reviewCount={12}
      />,
    );
    expect(html).toContain("Ďalšie hodnotenia");
    expect(html).toContain(
      `/remeselnici/${profileId}?reviewsCursor=v1.${page().nextCursor?.slice(3)}`,
    );
    expect(html).not.toMatch(/form|button|POST/iu);
  });

  it("formats only month and year", () => {
    expect(formatReviewedMonth("2026-09")).toBe("september 2026");
  });

  it("shows profession-specific score and evidence volume", () => {
    const scored = renderToStaticMarkup(
      <PublicProfessionReviewEvidence customerScore={4.25} reviewCount={2} />,
    );
    const empty = renderToStaticMarkup(
      <PublicProfessionReviewEvidence customerScore={null} reviewCount={0} />,
    );
    expect(scored).toContain("Zákaznícke hodnotenia v profesii: 2");
    expect(scored).toContain("Zákaznícke skóre v profesii: 4,3 z 5");
    expect(empty).toContain("Zákaznícke hodnotenia v profesii: 0");
    expect(empty).not.toContain("Zákaznícke skóre");
  });
});

function page(): PublicCraftsmanReviewsPage {
  return {
    reviews: [
      {
        reviewId,
        professionCode: "PROF:CARPENTER",
        ratings: {
          work_quality: 5,
          price_adherence: 4,
          schedule_adherence: null,
          communication: 5,
          cleanliness: 4,
          problem_solving: 5,
          would_hire_again: 5,
        },
        score: 4.67,
        comment: "Poctivá práca a dobrá komunikácia.",
        reviewedMonth: "2026-09",
      },
    ],
    nextCursor: "v1.84000000-0000-4000-8000-000000000003",
  };
}
