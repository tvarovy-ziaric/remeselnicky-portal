import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  loadMilestone,
  loadMilestoneHistory,
  loadMilestonePage,
  parseMilestoneHistoryPage,
  parseMilestoneItem,
  parseMilestonePage,
  sendMilestoneCommand,
  validMilestoneCommand,
} from "./job-milestone-data";
import {
  JobMilestoneDetail,
  JobMilestoneHistory,
  JobMilestones,
  MilestoneEditor,
  MilestoneHistoryItems,
  MilestoneSummary,
} from "./job-milestones";

const jobId = "95000000-0000-4000-8000-000000000101";
const milestoneId = "95000000-0000-4000-8000-000000000102";
const nextId = "95000000-0000-4000-8000-000000000103";
const quoteId = "95000000-0000-4000-8000-000000000104";
const mediaId = "95000000-0000-4000-8000-000000000105";
const commandId = "95000000-0000-4000-8000-000000000106";
const createdAt = "2026-09-17T12:00:00.000Z";
const item = {
  id: milestoneId,
  jobId,
  title: "Strecha",
  description: "Prípravné práce",
  state: "PLANNED",
  orderIndex: 0,
  originalPlannedStartOn: "2026-09-20",
  originalPlannedEndOn: "2026-09-22",
  currentPlannedStartOn: "2026-09-21",
  currentPlannedEndOn: "2026-09-23",
  acceptedStageLabel: "Etapa 1",
  sourceQuoteId: quoteId,
  sourceQuoteRevision: 2,
  sourcePdfDownloadPath: `/v1/media/${mediaId}/download`,
  sourceChangeOrderRevisionId: null,
  responsibility: null,
  createdAt,
  updatedAt: createdAt,
  acknowledgedAt: null,
  capabilities: {
    canEdit: true,
    canSetState: true,
    canMarkDone: true,
    canReorder: true,
    canAssign: true,
    canAcknowledge: false,
  },
};
const page = { items: [item], canCreate: true, nextCursor: null };
const historyEvent = {
  eventId: "95000000-0000-4000-8000-000000000107",
  sequence: 2,
  kind: "EDIT",
  actorUserId: "95000000-0000-4000-8000-000000000108",
  title: item.title,
  description: item.description,
  plannedStartOn: item.currentPlannedStartOn,
  plannedEndOn: item.currentPlannedEndOn,
  state: item.state,
  orderKey: "0.50000000000000000000",
  responsibility: null,
  acceptedStageLabel: item.acceptedStageLabel,
  sourceQuoteId: item.sourceQuoteId,
  sourceQuoteRevision: item.sourceQuoteRevision,
  sourcePdfDownloadPath: item.sourcePdfDownloadPath,
  sourceChangeOrderRevisionId: item.sourceChangeOrderRevisionId,
  recordedAt: createdAt,
};
const createEvent = {
  ...historyEvent,
  eventId: "95000000-0000-4000-8000-000000000109",
  sequence: 1,
  kind: "CREATE",
  plannedStartOn: item.originalPlannedStartOn,
  plannedEndOn: item.originalPlannedEndOn,
};
const response = (body: unknown, status = 200) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }) as Response;

describe("Job milestone web boundary", () => {
  it("validates exact private history, ordering, cursor, provenance and bounded page size", () => {
    expect(
      parseMilestoneHistoryPage({
        items: [historyEvent, createEvent],
        nextCursor: null,
      })?.items,
    ).toHaveLength(2);
    expect(
      parseMilestoneHistoryPage({ items: [historyEvent], nextCursor: 2 })
        ?.nextCursor,
    ).toBe(2);
    expect(
      parseMilestoneHistoryPage({
        items: [historyEvent, createEvent],
        nextCursor: 2,
      }),
    ).toBeNull();
    expect(
      parseMilestoneHistoryPage({
        items: [createEvent, historyEvent],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseMilestoneHistoryPage({
        items: [historyEvent, historyEvent],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseMilestoneHistoryPage({
        items: [{ ...historyEvent, actorEmail: "private@example.test" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseMilestoneHistoryPage({
        items: [{ ...historyEvent, orderKey: "Infinity" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseMilestoneHistoryPage({
        items: [
          { ...historyEvent, sourceQuoteId: nextId, sourceQuoteRevision: null },
        ],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseMilestoneHistoryPage({
        items: Array(21).fill(historyEvent),
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("loads exact-Job history with no-store and rejects IDOR and malformed replies", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(response({ items: [historyEvent], nextCursor: 2 })),
    );
    const loaded = await loadMilestoneHistory({
      fetch: fetcher,
      jobId,
      milestoneId,
      beforeSequence: 3,
    });
    expect(loaded.status).toBe("OK");
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/jobs/${jobId}/milestones/${milestoneId}/history?limit=20&beforeSequence=3`,
      { cache: "no-store", credentials: "same-origin" },
    );
    const forbidden = vi.fn(() => Promise.resolve(response({}, 404)));
    expect(
      (await loadMilestoneHistory({ fetch: forbidden, jobId, milestoneId }))
        .status,
    ).toBe("NOT_FOUND");
    const malformed = vi.fn(() =>
      Promise.resolve(
        response({
          items: [{ ...historyEvent, rawStorageKey: "hidden" }],
          nextCursor: null,
        }),
      ),
    );
    expect(
      (await loadMilestoneHistory({ fetch: malformed, jobId, milestoneId }))
        .status,
    ).toBe("UNAVAILABLE");
    const noNetwork = vi.fn();
    expect(
      (
        await loadMilestoneHistory({
          fetch: noNetwork,
          jobId,
          milestoneId,
          beforeSequence: 0,
        })
      ).status,
    ).toBe("UNAVAILABLE");
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("renders historical snapshots without raw actor/order identifiers or payment claims", () => {
    const parsed = parseMilestoneHistoryPage({
      items: [historyEvent, createEvent],
      nextCursor: null,
    });
    expect(parsed).not.toBeNull();
    const markup = renderToStaticMarkup(
      <MilestoneHistoryItems items={parsed!.items} />,
    );
    expect(markup).toContain("Pôvodný prevádzkový plán");
    expect(markup).toContain("Vtedajší prevádzkový plán");
    expect(markup).toContain("Odkaz na prijatú etapu");
    expect(markup).not.toContain(historyEvent.actorUserId);
    expect(markup).not.toContain(historyEvent.orderKey);
    expect(markup).not.toContain("Zaplatené");
    expect(
      renderToStaticMarkup(
        <JobMilestoneHistory jobId={jobId} milestoneId={milestoneId} />,
      ),
    ).toContain("Načítava sa história");
  });
  it("accepts a bounded exact-Job page and rejects extra/private or inconsistent source fields", () => {
    expect(parseMilestonePage(page, jobId)?.items).toHaveLength(1);
    expect(
      parseMilestonePage(
        { ...page, items: [{ ...item, jobId: nextId }] },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestonePage(
        { ...page, items: [{ ...item, paymentStatus: "PAID" }] },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestonePage(
        { ...page, items: [{ ...item, sourceQuoteId: null }] },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestonePage(
        { ...page, items: [{ ...item, sourceChangeOrderRevisionId: "bad" }] },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestonePage(
        {
          ...page,
          items: [
            { ...item, sourcePdfDownloadPath: "https://other.test/file" },
          ],
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestonePage(
        { ...page, items: [{ ...item, currentPlannedEndOn: "2026-09-20" }] },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestonePage(
        {
          ...page,
          items: [
            {
              ...item,
              capabilities: {
                ...item.capabilities,
                canMarkDone: false,
                canSetState: false,
                canPay: true,
              },
            },
          ],
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestonePage({ ...page, items: [item, item] }, jobId),
    ).toBeNull();
    expect(
      parseMilestonePage(
        { ...page, nextCursor: { afterOrder: 1, afterId: milestoneId } },
        jobId,
      ),
    ).toBeNull();
    expect(parseMilestoneItem({ ...item, title: "" }, jobId)).toBeNull();
  });

  it("uses no-store same-origin collection/detail reads and rejects an alien detail ID", async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(page)));
    expect(
      (
        await loadMilestonePage({
          fetch: fetcher,
          jobId,
        })
      ).status,
    ).toBe("OK");
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/jobs/${jobId}/milestones?limit=20`,
      { cache: "no-store", credentials: "same-origin" },
    );
    const detailFetch = vi.fn(() =>
      Promise.resolve(response({ ...item, id: nextId })),
    );
    expect(
      (
        await loadMilestone({
          fetch: detailFetch,
          jobId,
          milestoneId,
        })
      ).status,
    ).toBe("UNAVAILABLE");
    const forbidden = vi.fn(() => Promise.resolve(response({}, 404)));
    expect(
      (
        await loadMilestonePage({
          fetch: forbidden,
          jobId,
        })
      ).status,
    ).toBe("NOT_FOUND");
  });

  it("rejects invalid commands before network and sends a CSRF-protected idempotent request", async () => {
    expect(
      validMilestoneCommand({
        kind: "CREATE",
        title: "",
        plannedStartOn: null,
      }),
    ).toBe(false);
    expect(
      validMilestoneCommand({
        kind: "REORDER",
        milestoneId,
        afterMilestoneId: milestoneId,
      }),
    ).toBe(false);
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      void init;
      return Promise.resolve(
        path === "/v1/auth/csrf"
          ? response({ csrfToken: "csrf-test" })
          : response({ status: "APPLIED", milestoneId }),
      );
    });
    const result = await sendMilestoneCommand({
      fetch: fetcher as unknown as typeof fetch,
      jobId,
      commandId,
      command: { kind: "STATE", milestoneId, state: "DONE" },
    });
    expect(result).toEqual({ status: "OK", milestoneId });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/me/jobs/${jobId}/milestones/${milestoneId}/state`,
    );
    const post = fetcher.mock.calls[1]?.[1];
    expect(post?.method).toBe("POST");
    expect(post?.cache).toBe("no-store");
    expect(post?.credentials).toBe("same-origin");
    expect(new Headers(post?.headers).get("x-csrf-token")).toBe("csrf-test");
    expect(post?.body).toBe(JSON.stringify({ commandId, state: "DONE" }));
    const noNetwork = vi.fn() as unknown as typeof fetch;
    expect(
      (
        await sendMilestoneCommand({
          fetch: noNetwork,
          jobId,
          commandId,
          command: {
            kind: "REORDER",
            milestoneId,
            afterMilestoneId: milestoneId,
          },
        })
      ).status,
    ).toBe("UNAVAILABLE");
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("renders current and original plans and read-only commercial provenance without payment claims", () => {
    const parsed = parseMilestoneItem(item, jobId);
    expect(parsed).not.toBeNull();
    const markup = renderToStaticMarkup(<MilestoneSummary item={parsed!} />);
    expect(markup).toContain("Aktuálny prevádzkový plán");
    expect(markup).toContain("Pôvodný prevádzkový plán");
    expect(markup).toContain("Etapa podľa prijatej ponuky");
    expect(markup).toContain(`/v1/media/${mediaId}/download`);
    expect(markup).not.toContain("Zaplatené");
  });

  it("keeps customer or failed-read controls hidden; editor exposes no amount or payment field", () => {
    const shell = renderToStaticMarkup(
      <JobMilestones
        jobId={jobId}
        role="CUSTOMER"
        jobState="CONFIRMED"
        acceptedQuoteAvailable
      />,
    );
    expect(shell).toContain("Načítavajú sa míľniky");
    expect(shell).not.toContain("Pridať míľnik");
    const editor = renderToStaticMarkup(
      <MilestoneEditor
        draft={{
          title: "",
          description: "",
          plannedStartOn: "",
          plannedEndOn: "",
          acceptedStageLabel: "",
          sourceChangeOrderRevisionId: "",
        }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        pending={false}
        mode="CREATE"
        acceptedQuoteAvailable
      />,
    );
    expect(editor).toContain("Etapa uvedená v prijatej ponuke");
    expect(editor).not.toContain("Platba");
    expect(editor).not.toContain("Suma");
    const detail = renderToStaticMarkup(
      <JobMilestoneDetail jobId={jobId} milestoneId={milestoneId} />,
    );
    expect(detail).toContain("Načítava sa súkromný míľnik");
    expect(detail).not.toContain("Strecha");
  });
});
