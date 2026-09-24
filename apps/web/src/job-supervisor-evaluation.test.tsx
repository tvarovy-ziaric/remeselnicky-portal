import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type ReceivedSupervisorEvaluationPage,
  supervisorEvaluationDimensions,
  type SupervisorEvaluationPage,
  type SupervisorEvaluationRatings,
} from "./job-supervisor-evaluation-data";
import {
  JobSupervisorEvaluationView,
  ReceivedSupervisorEvaluationView,
} from "./job-supervisor-evaluation";

const jobId = "95200000-0000-4000-8000-000000000001";
const participantId = "95200000-0000-4000-8000-000000000002";
const profileId = "95200000-0000-4000-8000-000000000003";
const evaluationId = "95200000-0000-4000-8000-000000000004";
const revisionId = "95200000-0000-4000-8000-000000000005";
const now = Date.parse("2026-09-02T09:00:00.000Z");

const ratings = Object.fromEntries(
  supervisorEvaluationDimensions.map(([key]) => [key, 5]),
) as SupervisorEvaluationRatings;

const page = (): SupervisorEvaluationPage => ({
  jobId,
  completedAt: "2026-09-01T10:00:00.000Z",
  submissionDeadline: "2026-09-15T10:00:00.000Z",
  targets: [
    {
      participantId,
      participantProfileId: profileId,
      displayName: "Overený účastník",
      relationshipKind: "SITE_MANAGER",
      overlapStartedAt: "2026-08-20T08:00:00.000Z",
      overlapEndedAt: "2026-09-01T10:00:00.000Z",
      verifiedProfessionCodes: ["TEST:MURAR"],
      verifiedRoles: ["MEMBER"],
      evaluation: null,
    },
  ],
});

const received = (): ReceivedSupervisorEvaluationPage => ({
  jobId,
  evaluations: [
    {
      sourceType: "SUPERVISOR_EVALUATION",
      evaluationId,
      targetParticipantId: participantId,
      targetProfileId: profileId,
      evaluatorDisplayName: "Stavbyvedúci zákazky",
      relationshipKind: "SITE_MANAGER",
      overlapStartedAt: "2026-08-20T08:00:00.000Z",
      overlapEndedAt: "2026-09-01T10:00:00.000Z",
      verifiedProfessionCodes: ["TEST:MURAR"],
      verifiedTargetRoles: ["MEMBER"],
      submittedAt: "2026-09-02T08:00:00.000Z",
      revisedAt: "2026-09-02T08:00:00.000Z",
      ratings,
      comment: "Samostatná a spoľahlivá práca.",
    },
  ],
});

describe("supervisor evaluation private UX", () => {
  it("renders a concise eligible-target flow with plain-language dimensions and N/A", () => {
    const html = renderToStaticMarkup(
      <JobSupervisorEvaluationView page={page()} now={now} />,
    );
    expect(html).toContain("Odborné hodnotenia účastníkov");
    expect(html).toContain("Overený účastník");
    expect(html).toContain("stavbyvedúci");
    expect(html).toContain("preukázaným pracovným prekryvom");
    expect(html).toContain("Odborná kvalita a kompetentnosť");
    expect(html).toContain("Zobral/a by som ho/ju znovu do tímu");
    expect(html).toContain("Neviem posúdiť / netýka sa");
    expect(html).toContain("nie je zapečatenou zákazníckou");
  });

  it("shows the latest saved revision but no editor after the edit deadline", () => {
    const saved: SupervisorEvaluationPage = {
      ...page(),
      targets: [
        {
          ...page().targets[0]!,
          evaluation: {
            evaluationId,
            revisionId,
            version: 1,
            submittedAt: "2026-09-02T08:00:00.000Z",
            revisedAt: "2026-09-02T08:00:00.000Z",
            editDeadline: "2026-09-02T09:00:00.000Z",
            ratings,
            comment: "Samostatná a spoľahlivá práca.",
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <JobSupervisorEvaluationView page={saved} now={now} />,
    );
    expect(html).toContain("Vaše uložené odborné hodnotenie");
    expect(html).toContain("Samostatná a spoľahlivá práca.");
    expect(html).not.toContain("Uložiť úpravu");
  });

  it("shows raw evaluation only in the explicit private received view", () => {
    const html = renderToStaticMarkup(
      <ReceivedSupervisorEvaluationView
        page={received()}
        participantId={participantId}
      />,
    );
    expect(html).toContain("Moje odborné hodnotenia");
    expect(html).toContain("Stavbyvedúci zákazky");
    expect(html).toContain("Samostatná a spoľahlivá práca.");
    expect(html).toContain("Verejný profil nesmie zobraziť");
    expect(
      renderToStaticMarkup(
        <ReceivedSupervisorEvaluationView
          page={received()}
          participantId="95200000-0000-4000-8000-000000000099"
        />,
      ),
    ).toBe("");
  });
});
