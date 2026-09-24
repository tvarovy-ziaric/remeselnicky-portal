import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { JobDisputeDetail } from "./job-dispute-data";
import {
  JobDisputeDetailView,
  JobDisputePartyActions,
  JobDisputes,
} from "./job-disputes";

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
    canWithdraw: false,
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
    adminRequests: [
      {
        id: quoteId,
        recipient: "PRIMARY_PROVIDER",
        requestText: "Doplňte fotografiu opraveného detailu.",
        replyDeadline: "2026-09-30T10:00:00.000Z",
        requestedAt: "2026-09-24T11:00:00.000Z",
      },
    ],
    outcome:
      state === "CLOSED"
        ? {
            id: mediaAssetId,
            category: "OPERATIONAL_ADMIN_RESOLUTION",
            basis: "ADMINISTRATIVE_CLOSURE",
            summary:
              "Prípad bol prevádzkovo uzavretý bez právneho rozhodnutia.",
            recordedAt: "2026-09-24T12:00:00.000Z",
          }
        : null,
    settlementConfirmations: [],
    caseTimeline: [
      {
        eventId: disputeId,
        action: "OPEN",
        fromState: null,
        toState: "OPEN",
        occurredAt: "2026-09-24T10:00:00.000Z",
      },
      ...(state === "CLOSED"
        ? [
            {
              eventId: quoteId,
              action: "CLOSE",
              fromState: "RESOLVED" as const,
              toState: "CLOSED" as const,
              occurredAt: "2026-09-24T12:01:00.000Z",
            },
          ]
        : []),
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
    expect(html).toContain("Doplňte fotografiu opraveného detailu.");
    expect(html).toContain("Zmeškanie prevádzkového termínu");
    expect(html).toContain("JOB_CONFIRMED");
    expect(html).not.toContain("Rozhodnúť spor");
    expect(html).not.toContain("Vrátiť peniaze");
  });

  it("keeps resolved history readable but removes every content mutation control", () => {
    const html = renderDetail(detail("CLOSED"));
    expect(html).toContain("Uzavretý");
    expect(html).toContain("Miesto zatekania po daždi.");
    expect(html).toContain("prevádzkovo uzavretý bez právneho rozhodnutia");
    expect(html).toContain("nie právny rozsudok ani zmena prijatej dohody");
    expect(html).not.toContain("Pridať nemenné vyjadrenie");
    expect(html).not.toContain("Pripojiť existujúci dôkaz zo zákazky");
    expect(html).not.toContain("Nahrať nový súkromný dôkaz");
  });

  it("explains exact bilateral settlement and opener-only withdrawal", () => {
    const openerDetail = {
      ...detail(),
      viewerRole: "CUSTOMER" as const,
      canWithdraw: true,
    };
    const html = renderToStaticMarkup(
      <JobDisputePartyActions
        detail={openerDetail}
        onConfirmSettlement={asyncNoop}
        onSettlementSummary={noop}
        onWithdraw={asyncNoop}
        onWithdrawalReason={noop}
        pending={false}
        settlementSummary=""
        withdrawalReason=""
      />,
    );
    expect(html).toContain("úplne rovnaké stručné zhrnutie");
    expect(html).toContain("nemení prijatú ponuku");
    expect(html).toContain("Stiahnuť prípad");
    expect(html).toContain("História zostane zachovaná");

    const counterparty = renderToStaticMarkup(
      <JobDisputePartyActions
        detail={detail()}
        onConfirmSettlement={asyncNoop}
        onSettlementSummary={noop}
        onWithdraw={asyncNoop}
        onWithdrawalReason={noop}
        pending={false}
        settlementSummary=""
        withdrawalReason=""
      />,
    );
    expect(counterparty).toContain("Potvrdiť vlastnú dohodu strán");
    expect(counterparty).not.toContain("Stiahnuť prípad");
  });
});
