import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  customerToProviderReviewDimensions,
  type JobMainReviewPage,
  type JobMainReviewRatings,
  providerToCustomerReviewDimensions,
} from "./job-main-review-data";
import { JobMainReviewView } from "./job-main-review";

const jobId = "93700000-0000-4000-8000-000000000001";
const profileId = "93700000-0000-4000-8000-000000000002";
const ownRevisionId = "93700000-0000-4000-8000-000000000003";
const otherRevisionId = "93700000-0000-4000-8000-000000000004";
const submittedAt = "2026-09-20T08:10:00.000Z";
const now = Date.parse("2026-09-20T08:30:00.000Z");

const ratings = (entries: readonly (readonly [string, string])[]) =>
  Object.fromEntries(
    entries.map(([key], index) => [key, index === 0 ? 4 : null]),
  ) as JobMainReviewRatings;

function openPage(
  direction: JobMainReviewPage["direction"] = "CUSTOMER_TO_PROVIDER",
): JobMainReviewPage {
  return {
    jobId,
    direction,
    targetProfileId: profileId,
    targetKind:
      direction === "CUSTOMER_TO_PROVIDER"
        ? "CRAFTSMAN_PROFILE"
        : "CUSTOMER_PROFILE",
    acceptedProfessionCode: "PROF:ROOFING",
    completedAt: "2026-09-20T08:00:00.000Z",
    submissionDeadline: "2026-10-04T08:00:00.000Z",
    state: "OPEN",
    ownReview: null,
    counterpartyReview: null,
  };
}

describe("completed Job main review section", () => {
  it("renders every exact customer-to-provider label with an N/A option and neutral sealed copy", () => {
    const html = renderToStaticMarkup(
      <JobMainReviewView page={openPage()} now={now} />,
    );
    for (const [, label] of customerToProviderReviewDimensions)
      expect(html).toContain(label);
    expect(html.match(/Neviem posúdiť \/ netýka sa/gu)).toHaveLength(7);
    expect(html).toContain("Odoslať hodnotenie");
    expect(html).toContain("pozitívne, neutrálne alebo kritické");
    expect(html).toContain("Druhá strana vaše hodnotenie neuvidí");
    expect(html).not.toContain("Hodnotenie zákazníka od druhej strany");
  });

  it("uses provider-to-customer wording that identifies payment as reported experience, not verified fact", () => {
    const html = renderToStaticMarkup(
      <JobMainReviewView page={openPage("PROVIDER_TO_CUSTOMER")} now={now} />,
    );
    for (const [, label] of providerToCustomerReviewDimensions)
      expect(html).toContain(label);
    expect(html.match(/Neviem posúdiť \/ netýka sa/gu)).toHaveLength(6);
    expect(html).toContain("uvádzate vy");
    expect(html).toContain("Nejde o platformou overený údaj o zaplatení");
  });

  it("shows the author's latest sealed content and permits a versioned edit only inside the short window", () => {
    const page: JobMainReviewPage = {
      ...openPage(),
      state: "SUBMITTED_SEALED",
      ownReview: {
        revisionId: ownRevisionId,
        version: 2,
        submittedAt,
        revisedAt: "2026-09-20T08:20:00.000Z",
        ratings: ratings(customerToProviderReviewDimensions),
        comment: "Moje posledné uložené znenie.",
      },
    };
    const editable = renderToStaticMarkup(
      <JobMainReviewView page={page} now={now} />,
    );
    expect(editable).toContain("Vaše posledné uložené hodnotenie");
    expect(editable).toContain("Moje posledné uložené znenie.");
    expect(editable).toContain("verzia");
    expect(editable).toContain("2");
    expect(editable).toContain("Uložiť úpravu");
    expect(editable).toContain("možnosť úpravy sa skončí skôr");
    const locked = renderToStaticMarkup(
      <JobMainReviewView
        page={page}
        now={Date.parse(submittedAt) + 60 * 60 * 1_000}
      />,
    );
    expect(locked).toContain("Moje posledné uložené znenie.");
    expect(locked).not.toContain("Uložiť úpravu");
  });

  it("never renders an edit after unlock or expiry and shows counterparty content only when supplied by the API", () => {
    const unlocked: JobMainReviewPage = {
      ...openPage(),
      state: "UNLOCKED",
      ownReview: {
        revisionId: ownRevisionId,
        version: 1,
        submittedAt,
        revisedAt: submittedAt,
        ratings: ratings(customerToProviderReviewDimensions),
        comment: null,
      },
      counterpartyReview: {
        direction: "PROVIDER_TO_CUSTOMER",
        revisionId: otherRevisionId,
        submittedAt: "2026-09-20T08:20:00.000Z",
        revisedAt: "2026-09-20T08:20:00.000Z",
        unlockedAt: "2026-09-20T08:20:00.000Z",
        ratings: ratings(providerToCustomerReviewDimensions),
        comment: "Vecná odpoveď druhej strany.",
      },
    };
    const html = renderToStaticMarkup(
      <JobMainReviewView page={unlocked} now={now} />,
    );
    expect(html).toContain("Hodnotenie je odomknuté");
    expect(html).toContain("Vecná odpoveď druhej strany.");
    expect(html).toContain("Hodnotenie zákazníka od druhej strany");
    expect(html).not.toContain("Uložiť úpravu");
    expect(html).not.toContain("Odoslať hodnotenie");

    const expired: JobMainReviewPage = {
      ...openPage(),
      submissionDeadline: "2026-09-21T08:00:00.000Z",
      state: "EXPIRED_UNSUBMITTED",
    };
    const expiredHtml = renderToStaticMarkup(
      <JobMainReviewView page={expired} now={now} />,
    );
    expect(expiredHtml).toContain("Vlastné hodnotenie už nemožno odoslať");
    expect(expiredHtml).not.toContain("Odoslať hodnotenie");
    expect(expiredHtml).not.toContain("od druhej strany");
  });

  it("offers the rated provider one response and report path only for the public customer review", () => {
    const providerPage: JobMainReviewPage = {
      ...openPage("PROVIDER_TO_CUSTOMER"),
      state: "UNLOCKED",
      ownReview: {
        revisionId: ownRevisionId,
        version: 1,
        submittedAt,
        revisedAt: submittedAt,
        ratings: ratings(providerToCustomerReviewDimensions),
        comment: null,
      },
      counterpartyReview: {
        direction: "CUSTOMER_TO_PROVIDER",
        revisionId: otherRevisionId,
        submittedAt,
        revisedAt: submittedAt,
        unlockedAt: submittedAt,
        ratings: ratings(customerToProviderReviewDimensions),
        comment: "Vecná zákaznícka recenzia.",
      },
    };
    const html = renderToStaticMarkup(
      <JobMainReviewView page={providerPage} now={now} />,
    );
    expect(html).toContain("Nahlásiť hodnotenie");
    expect(html).toContain("Načítavam vašu verejnú odpoveď");
  });
});
