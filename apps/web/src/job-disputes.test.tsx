import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { JobDisputeDetail } from "./job-dispute-data";
import { JobDisputeDetailView, JobDisputes } from "./job-disputes";

const jobId = "98100000-0000-4000-8000-000000000001";
const disputeId = "98100000-0000-4000-8000-000000000002";
const quoteId = "98100000-0000-4000-8000-000000000003";
const mediaAssetId = "98100000-0000-4000-8000-000000000004";
const evidenceId = "98100000-0000-4000-8000-000000000005";
const statementId = "98100000-0000-4000-8000-000000000006";
const eventId = "98100000-0000-4000-8000-000000000007";

function detail(state: "OPEN" | "CLOSED" = "OPEN"): JobDisputeDetail {
  return {
    id: disputeId,
    jobId,
    openedByRole: "CUSTOMER",
    viewerRole: "PRIMARY_PROVIDER",
    category: "QUALITY_DEFECT",
    description: "Opravená časť strechy stále zateká.",
    desiredResolution: "Odstrániť zatekanie.",
    state,
    stateRevision: state === "OPEN" ? 1 : 2,
    createdAt: "2026-09-24T10:00:00.000Z",
    stateChangedAt: "2026-09-24T10:00:00.000Z",
    canAddContent: state === "OPEN",
    statements: [
      {
        id: statementId,
        authorRole: "CUSTOMER",
        kind: "STATEMENT",
        body: "Vada je viditeľná na priloženej fotografii.",
        createdAt: "2026-09-24T10:01:00.000Z",
      },
    ],
    evidence: [
      {
        id: evidenceId,
        submittedByRole: "CUSTOMER",
        source: "NEW_UPLOAD",
        mediaAssetId,
        kind: "PHOTO",
        description: "Miesto zatekania po daždi.",
        displayFilename: null,
        contentType: "image/webp",
        downloadPath: `/v1/media/${mediaAssetId}/download`,
        createdAt: "2026-09-24T10:02:00.000Z",
      },
    ],
    commercialBaseline: {
      acceptedRequestContentRevision: 2,
      acceptedRequestVisibleVersion: 3,
      acceptedQuoteId: quoteId,
      acceptedQuoteRevision: 4,
      acceptedQuoteMode: "EXTERNAL_PDF",
      acceptedQuotePdfDownloadPath: `/v1/media/${quoteId}/download`,
      approvedChanges: [],
      jobDashboardPath: `/zakazky/${jobId}`,
    },
    jobTimeline: [
      {
        eventId,
        eventType: "JOB_CONFIRMED",
        occurredAt: "2026-09-20T10:00:00.000Z",
      },
    ],
  };
}

const noop = vi.fn();
const asyncNoop = vi.fn(() => Promise.resolve());

function renderDetail(caseDetail: JobDisputeDetail) {
  return renderToStaticMarkup(
    <JobDisputeDetailView
      detail={caseDetail}
      documents={[]}
      existingDescription=""
      existingMediaAssetId=""
      file={null}
      onAddStatement={asyncNoop}
      onBindExisting={asyncNoop}
      onCheckUpload={asyncNoop}
      onExistingDescription={noop}
      onExistingMediaAssetId={noop}
      onFile={noop}
      onStatement={noop}
      onStatementKind={noop}
      onUpload={asyncNoop}
      onUploadDescription={noop}
      pending={false}
      pendingUpload={null}
      statement=""
      statementKind="STATEMENT"
      uploadDescription=""
    />,
  );
}

describe("D22 private dispute UI", () => {
  it("states the non-legal boundary and exposes a private append-only case form", () => {
    const html = renderToStaticMarkup(<JobDisputes jobId={jobId} />);
    expect(html).toContain("Súkromné sporné prípady");
    expect(html).toContain(
      "nemení prijatú dohodu, platbu, hodnotenie ani stav zákazky",
    );
    expect(html).toContain("nerozhoduje právny spor ani nepriznáva náhradu");
    expect(html).toContain("bez tichého prepisu");
    expect(html).toContain("Otvoriť súkromný prípad");
  });

  it("renders immutable commercial context, party history and private evidence", () => {
    const html = renderDetail(detail());
    expect(html).toContain("Nemeniteľný obchodný základ");
    expect(html).toContain("prijatá ponuka revízia 4");
    expect(html).toContain(`/zakazky/${jobId}`);
    expect(html).toContain(`/v1/media/${mediaAssetId}/download`);
    expect(html).toContain("Vada je viditeľná na priloženej fotografii.");
    expect(html).toContain("Pridať nemenné vyjadrenie");
    expect(html).toContain("Nahrať nový súkromný dôkaz");
    expect(html).toContain("JOB_CONFIRMED");
    expect(html).not.toContain("Rozhodnúť spor");
    expect(html).not.toContain("Vrátiť peniaze");
  });

  it("keeps resolved history readable but removes every content mutation control", () => {
    const html = renderDetail(detail("CLOSED"));
    expect(html).toContain("Uzavretý");
    expect(html).toContain("Miesto zatekania po daždi.");
    expect(html).not.toContain("Pridať nemenné vyjadrenie");
    expect(html).not.toContain("Pripojiť existujúci dôkaz zo zákazky");
    expect(html).not.toContain("Nahrať nový súkromný dôkaz");
  });
});
