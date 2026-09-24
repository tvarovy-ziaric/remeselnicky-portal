import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type JobContextReviewPage,
  participantReviewDimensions,
  type JobContextReviewRatings,
  workGroupReviewDimensions,
} from "./job-context-review-data";
import {
  JobContextReviewDetails,
  JobContextReviewView,
} from "./job-context-review";

const jobId = "94200000-0000-4000-8000-000000000001";
const participantId = "94200000-0000-4000-8000-000000000002";
const participantProfileId = "94200000-0000-4000-8000-000000000003";
const workGroupId = "94200000-0000-4000-8000-000000000004";
const assignmentId = "94200000-0000-4000-8000-000000000005";
const revisionId = "94200000-0000-4000-8000-000000000006";
const now = Date.parse("2026-09-20T08:30:00.000Z");

const ratings = (dimensions: readonly (readonly [string, string])[]) =>
  Object.fromEntries(
    dimensions.map(([key], index) => [key, index === 0 ? 4 : null]),
  ) as JobContextReviewRatings;

function page(): JobContextReviewPage {
  return {
    jobId,
    completedAt: "2026-09-20T08:00:00.000Z",
    submissionDeadline: "2026-10-04T08:00:00.000Z",
    participants: [
      {
        targetKind: "PARTICIPANT",
        participantId,
        participantProfileId,
        displayName: "Marek K.",
        participationStartedAt: "2026-09-18T08:00:00.000Z",
        participationEndedAt: "2026-09-20T08:00:00.000Z",
        verifiedProfessionCodes: ["PROF:ROOFING"],
        verifiedRoles: ["MEMBER", "LEAD"],
        review: null,
      },
    ],
    workGroups: [
      {
        targetKind: "WORK_GROUP",
        workGroupId,
        name: "Strešná skupina",
        members: [
          {
            assignmentId,
            participantId,
            participantProfileId,
            displayName: "Marek K.",
            overlapStartedAt: "2026-09-18T09:00:00.000Z",
            overlapEndedAt: "2026-09-19T16:00:00.000Z",
          },
        ],
        review: {
          revisionId,
          version: 2,
          submittedAt: "2026-09-20T08:10:00.000Z",
          revisedAt: "2026-09-20T08:20:00.000Z",
          editDeadline: "2026-09-20T09:10:00.000Z",
          ratings: ratings(workGroupReviewDimensions),
          comment: "Vecná skúsenosť so skupinou.",
        },
      },
    ],
  };
}

describe("optional participant and historical work-group reviews", () => {
  it("starts behind one neutral explicit reveal and does not expose target details early", () => {
    const html = renderToStaticMarkup(
      <JobContextReviewView page={page()} now={now} />,
    );
    expect(html).toContain("Pokračovať k voliteľným hodnoteniam");
    expect(html).toContain("Každé hodnotenie je nepovinné");
    expect(html).not.toContain("Marek K.");
    expect(html).not.toContain("Strešná skupina");
  });

  it("shows only server-derived Job professions, roles, and historical roster with exact dimensions", () => {
    const html = renderToStaticMarkup(
      <JobContextReviewDetails page={page()} now={now} />,
    );
    expect(html).toContain("Overené profesie pri tejto zákazke: PROF:ROOFING");
    expect(html).toContain(
      "Overené úlohy pri tejto zákazke: člen/ka, vedúci/a",
    );
    expect(html).toContain("Historická pracovná skupina");
    expect(html).toContain("Marek K.");
    expect(html).toContain("Hodnotenie skupiny sa neprenáša");
    expect(html).not.toContain("Crew");
    for (const [, label] of participantReviewDimensions)
      expect(html).toContain(label);
    for (const [, label] of workGroupReviewDimensions)
      expect(html).toContain(label);
    expect(html).toContain("Vecná skúsenosť so skupinou.");
    expect(html).toContain("verzia");
    expect(html).toContain("Upraviť môžete do");
    expect(html).toContain("pozitívne, neutrálne alebo kritické");
  });

  it("renders neutral zero-profession copy and never offers a new review after the deadline", () => {
    const expired: JobContextReviewPage = {
      ...page(),
      submissionDeadline: "2026-09-20T08:20:00.000Z",
      participants: [
        {
          ...page().participants[0]!,
          verifiedProfessionCodes: [],
        },
      ],
      workGroups: [
        {
          ...page().workGroups[0]!,
          review: null,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <JobContextReviewDetails page={expired} now={now} />,
    );
    expect(html).toContain(
      "Pri tejto zákazke nebola potvrdená konkrétna profesia.",
    );
    expect(html.match(/Lehota už uplynula\./gu)).toHaveLength(2);
    expect(html).not.toContain("Odoslať hodnotenie");
    expect(html).not.toContain("Uložiť úpravu");
  });
});
