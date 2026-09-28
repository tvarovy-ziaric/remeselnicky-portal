import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChangeTerms } from "./change-order-data";
import { ChangeTermsView } from "./change-orders";
import { SafeLinkedText } from "./conversation-chat";
import { JobListView } from "./job-dashboard-list";
import { IssueComments } from "./job-operations";
import type { PublicCraftsmanReviewsPage } from "./public-craftsman-reviews-client";
import { PublicCraftsmanReviews } from "./public-craftsman-reviews";

const maliciousText =
  '<script>globalThis.pwned=true</script><img src=x onerror="alert(1)">';
const jobId = "9f100000-0000-4000-8000-000000000001";

describe("R4-031 persisted free-text rendering", () => {
  it("renders request, operational and change-order text only as inert text", () => {
    const request = renderToStaticMarkup(
      <JobListView
        jobs={[
          {
            acceptedAt: "2026-09-28T06:00:00.000Z",
            id: jobId,
            providerDisplayName: maliciousText,
            requestTitle: maliciousText,
            role: "CUSTOMER",
            state: "CONFIRMED",
          },
        ]}
      />,
    );
    const operations = renderToStaticMarkup(
      <IssueComments
        items={[
          {
            authorDisplayName: maliciousText,
            authorRole: "PRIMARY_PROVIDER",
            body: maliciousText,
            createdAt: "2026-09-28T06:01:00.000Z",
            id: "9f100000-0000-4000-8000-000000000002",
          },
        ]}
      />,
    );
    const changes = renderToStaticMarkup(
      <ChangeTermsView terms={maliciousChangeTerms()} />,
    );

    for (const markup of [request, operations, changes]) {
      expectInertText(markup);
    }
  });

  it("keeps public review comments and provider responses inert", () => {
    const page: PublicCraftsmanReviewsPage = {
      nextCursor: null,
      reviews: [
        {
          comment: maliciousText,
          professionCode: "PROF:ALPHA_SYNTHETIC",
          ratings: {
            cleanliness: 5,
            communication: 5,
            price_adherence: 5,
            problem_solving: 5,
            schedule_adherence: 5,
            work_quality: 5,
            would_hire_again: 5,
          },
          response: {
            body: maliciousText,
            respondedMonth: "2026-09",
            responseId: "9f100000-0000-4000-8000-000000000004",
          },
          reviewId: "9f100000-0000-4000-8000-000000000003",
          reviewedMonth: "2026-09",
          score: 5,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <PublicCraftsmanReviews
        page={page}
        professionLabels={{ "PROF:ALPHA_SYNTHETIC": maliciousText }}
        profileId="9f100000-0000-4000-8000-000000000005"
        reviewCount={1}
      />,
    );

    expectInertText(markup);
  });

  it("links only explicit HTTP(S) chat text and keeps active schemes inert", () => {
    const markup = renderToStaticMarkup(
      <SafeLinkedText
        value={`${maliciousText} javascript:alert(1) https://example.test/path?q="<tag>`}
      />,
    );

    expectInertText(markup);
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain('href="https://example.test/');
    expect(markup).toContain('rel="nofollow noreferrer"');
    expect(markup).toContain('target="_blank"');
  });
});

function expectInertText(markup: string): void {
  expect(markup).toContain("&lt;script&gt;");
  expect(markup).toContain("&lt;img");
  expect(markup).not.toMatch(/<(?:script|img)\b/iu);
}

function maliciousChangeTerms(): ChangeTerms {
  return {
    affectedMilestoneIds: [],
    changeDescription: maliciousText,
    externalPdfDownloadPath: null,
    materialResponsibility: null,
    otherConditionChange: maliciousText,
    priceImpact: { mode: "NONE" },
    reason: maliciousText,
    scheduleImpact: { mode: "NONE" },
    scopeAdded: [maliciousText],
    scopeChanged: [maliciousText],
    scopeRemoved: [maliciousText],
    title: maliciousText,
    warrantyChange: maliciousText,
  };
}
