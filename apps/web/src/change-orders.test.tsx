import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  loadChangeDetail,
  loadChangeOrders,
  loadChangePdfStatus,
  loadExactRevision,
  parseChangeDetail,
  parseChangePage,
  parseChangeRevision,
  parseChangeTerms,
  sendChangeCommand,
  startChangePdf,
  resumeChangePdf,
  type ChangeTerms,
} from "./change-order-data";
import { ChangeTermsView } from "./change-orders";

const jobId = "00000000-0000-4000-8000-000000000001";
const changeOrderId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const commandId = "00000000-0000-4000-8000-000000000004";
const now = "2026-09-17T10:00:00.000Z";
const terms: ChangeTerms = {
  title: "Pridať montáž",
  reason: "Nová požiadavka",
  changeDescription: "Doplnenie montáže svietidla",
  scopeAdded: ["Montáž svietidla"],
  scopeRemoved: [],
  scopeChanged: [],
  priceImpact: {
    mode: "ESTIMATE_DELTA",
    amountCents: 20000,
    basis: "Podľa rozsahu",
    vatStatus: "VAT_INCLUDED",
  },
  scheduleImpact: { mode: "NONE" },
  materialResponsibility: null,
  warrantyChange: null,
  otherConditionChange: null,
  affectedMilestoneIds: [],
  externalPdfDownloadPath: null,
};
const revision = {
  revisionId,
  revisionNumber: 1,
  state: "PROPOSED",
  authoredSide: "PRIMARY_PROVIDER",
  terms,
  pdfContentSha256: null,
  createdAt: now,
  stateChangedAt: now,
};
const detail = {
  changeOrderId,
  jobId,
  createdBySide: "PRIMARY_PROVIDER",
  createdAt: now,
  revisions: [revision],
  actions: [
    {
      id: commandId,
      revisionId,
      sequence: 1,
      action: "PROPOSE",
      supersededByRevisionId: null,
      occurredAt: now,
    },
  ],
};
const page = {
  items: [
    {
      changeOrderId,
      revisionId,
      revisionNumber: 1,
      state: "PROPOSED",
      title: terms.title,
      authoredSide: "PRIMARY_PROVIDER",
      createdAt: now,
    },
  ],
  nextCursor: null,
};
const response = (value: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(value),
  }) as Response;

describe("R4-012 exact change order boundary", () => {
  it("accepts a complete exact revision and refuses extra private fields", () => {
    expect(parseChangeRevision(revision, revisionId)).not.toBeNull();
    expect(parseChangeRevision(revision, commandId)).toBeNull();
    expect(
      parseChangeRevision(
        { ...revision, authoredByUserId: commandId },
        revisionId,
      ),
    ).toBeNull();
    expect(
      parseChangeRevision(
        {
          ...revision,
          terms: { ...terms, externalPdfDownloadPath: "/v1/media/x/download" },
        },
        revisionId,
      ),
    ).toBeNull();
    expect(
      parseChangeTerms({
        ...terms,
        priceImpact: {
          mode: "RANGE_DELTA",
          minimumCents: 500,
          maxiumumCents: 1000,
          basis: "Odhad",
          vatStatus: "VAT_INCLUDED",
        },
      }),
    ).toBeNull();
  });
  it("rejects a cross-job detail, unknown actor data and oversized collection", () => {
    expect(parseChangeDetail(detail, jobId, changeOrderId)).not.toBeNull();
    expect(
      parseChangeDetail(
        { ...detail, actions: [{ ...detail.actions[0], sequence: 0 }] },
        jobId,
        changeOrderId,
      ),
    ).toBeNull();
    expect(parseChangeDetail(detail, commandId, changeOrderId)).toBeNull();
    expect(
      parseChangeDetail(
        { ...detail, actions: [{ ...detail.actions[0], actorUserId: jobId }] },
        jobId,
        changeOrderId,
      ),
    ).toBeNull();
    expect(
      parseChangePage({
        ...page,
        items: Array.from({ length: 21 }, () => page.items[0]),
      }),
    ).toBeNull();
  });
  it("uses no-store, same-origin and exact object endpoint", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(response(page))
      .mockResolvedValueOnce(response(detail))
      .mockResolvedValueOnce(response(revision));
    const fetcher = mock as unknown as typeof fetch;
    expect((await loadChangeOrders(fetcher, jobId)).status).toBe("OK");
    expect((await loadChangeDetail(fetcher, jobId, changeOrderId)).status).toBe(
      "OK",
    );
    expect(
      (await loadExactRevision(fetcher, jobId, changeOrderId, revisionId))
        .status,
    ).toBe("OK");
    const calls = mock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map((call) => call[0])).toEqual([
      `/v1/me/jobs/${jobId}/change-orders?limit=20`,
      `/v1/me/jobs/${jobId}/change-orders/${changeOrderId}`,
      `/v1/me/jobs/${jobId}/change-orders/${changeOrderId}/revisions/${revisionId}`,
    ]);
    expect(
      calls.every(
        (call) =>
          call[1].cache === "no-store" && call[1].credentials === "same-origin",
      ),
    ).toBe(true);
  });
  it("fails closed on 404 and malformed exact revision", async () => {
    const missing = vi
      .fn()
      .mockResolvedValue(response({ code: "NOT_FOUND" }, 404));
    expect(
      (
        await loadExactRevision(
          missing as unknown as typeof fetch,
          jobId,
          changeOrderId,
          revisionId,
        )
      ).status,
    ).toBe("NOT_FOUND");
    const wrong = vi
      .fn()
      .mockResolvedValue(response({ ...revision, revisionId: commandId }));
    expect(
      (
        await loadExactRevision(
          wrong as unknown as typeof fetch,
          jobId,
          changeOrderId,
          revisionId,
        )
      ).status,
    ).toBe("UNAVAILABLE");
  });
  it("posts CSRF-protected commands without an unprotected PDF field", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(response({ csrfToken: "secret" }))
      .mockResolvedValueOnce(
        response(
          {
            status: "APPLIED",
            changeOrderId,
            revisionId,
            revisionNumber: 1,
            state: "DRAFT",
            occurredAt: now,
          },
          201,
        ),
      );
    const result = await sendChangeCommand(mock, jobId, commandId, {
      kind: "CREATE",
      revisionId,
      terms,
    });
    expect(result.status).toBe("OK");
    const request = mock.mock.calls.at(1)?.[1] as {
      headers: Record<string, string>;
      body: string;
    };
    expect(request.headers["x-csrf-token"]).toBe("secret");
    const body = JSON.parse(request.body) as { terms: Record<string, unknown> };
    expect(body.terms).not.toHaveProperty("externalPdfDownloadPath");
    expect(body.terms.externalPdfMediaAssetId).toBeNull();
  });
  it("refuses a mismatched command result and never treats conflict as approval", async () => {
    const wrong = vi
      .fn()
      .mockResolvedValueOnce(response({ csrfToken: "secret" }))
      .mockResolvedValueOnce(
        response({
          status: "APPLIED",
          changeOrderId,
          revisionId: commandId,
          revisionNumber: 1,
          state: "APPROVED",
          occurredAt: now,
        }),
      );
    expect(
      (
        await sendChangeCommand(
          wrong as unknown as typeof fetch,
          jobId,
          commandId,
          { kind: "APPROVE", changeOrderId, revisionId, revisionNumber: 1 },
        )
      ).status,
    ).toBe("UNAVAILABLE");
    const stale = vi
      .fn()
      .mockResolvedValueOnce(response({ csrfToken: "secret" }))
      .mockResolvedValueOnce(response({ code: "STALE_STATE" }, 409));
    expect(
      (
        await sendChangeCommand(
          stale as unknown as typeof fetch,
          jobId,
          commandId,
          { kind: "APPROVE", changeOrderId, revisionId, revisionNumber: 1 },
        )
      ).status,
    ).toBe("CONFLICT");
  });
  it("labels estimate as uncertain and never fabricates a total", () => {
    const html = renderToStaticMarkup(<ChangeTermsView terms={terms} />);
    expect(html).toContain("Odhad zmeny ceny");
    expect(html).toContain("Nie je to presná výsledná cena");
    expect(html).not.toContain("Výsledná cena");
  });
  it("permits only a private exact PDF download path", () => {
    const path = `/v1/media/${commandId}/download`;
    expect(
      parseChangeTerms({ ...terms, externalPdfDownloadPath: path }),
    ).not.toBeNull();
    expect(
      parseChangeTerms({
        ...terms,
        externalPdfDownloadPath: "https://evil.invalid/file.pdf",
      }),
    ).toBeNull();
    const html = renderToStaticMarkup(
      <ChangeTermsView terms={{ ...terms, externalPdfDownloadPath: path }} />,
    );
    expect(html).toContain(`href="${path}"`);
  });
  it("reserves, uploads, reads READY and only then creates one exact PDF revision", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const assetId = "00000000-0000-4000-8000-000000000005";
    const mock = vi
      .fn()
      .mockResolvedValueOnce(response({ csrfToken: "secret" }))
      .mockResolvedValueOnce(
        response(
          {
            status: "AUTHORIZED",
            reservationId: commandId,
            revisionNumber: 1,
            expiresAt,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(response({ csrfToken: "secret" }))
      .mockResolvedValueOnce(response({ status: "PROCESSING", assetId }, 202))
      .mockResolvedValueOnce(
        response({ status: "READY", expiresAt, canCreateRevision: true }),
      )
      .mockResolvedValueOnce(response({ csrfToken: "secret" }))
      .mockResolvedValueOnce(
        response(
          {
            status: "APPLIED",
            changeOrderId: commandId,
            revisionId,
            revisionNumber: 1,
            state: "DRAFT",
            occurredAt: now,
          },
          201,
        ),
      );
    const file = new File(["%PDF-1.7 synthetic"], "addendum.pdf", {
      type: "application/pdf",
    });
    const messages: string[] = [];
    const result = await startChangePdf(
      mock,
      jobId,
      commandId,
      { kind: "CREATE", revisionId, terms },
      file,
      (message) => messages.push(message),
    );
    expect(result.status).toBe("OK");
    const calls = mock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[1]?.[0]).toBe(
      `/v1/me/jobs/${jobId}/change-order-pdf-reservations`,
    );
    expect(calls[3]?.[0]).toBe(
      `/v1/me/jobs/${jobId}/change-order-revisions/${revisionId}/pdf`,
    );
    expect(calls[4]?.[0]).toBe(
      `/v1/me/jobs/${jobId}/change-order-revisions/${revisionId}/pdf/${assetId}/status`,
    );
    expect(calls[6]?.[0]).toBe(`/v1/me/jobs/${jobId}/change-orders`);
    expect(calls[3]?.[1].headers).toMatchObject({
      "content-type": "application/pdf",
      "x-csrf-token": "secret",
    });
    const body = JSON.parse(calls[6]?.[1].body as string) as {
      terms: { externalPdfMediaAssetId: string };
    };
    expect(body.terms.externalPdfMediaAssetId).toBe(assetId);
    expect(messages.at(-1)).toContain("Ukladám revíziu");
  });
  it("never binds a rejected, foreign or expired PDF", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const mediaAssetId = "00000000-0000-4000-8000-000000000005";
    const mock = vi
      .fn()
      .mockResolvedValue(
        response({ status: "REJECTED", expiresAt, canCreateRevision: false }),
      );
    const pending = {
      jobId,
      commandId,
      revisionId,
      mediaAssetId,
      expiresAt,
      command: { kind: "CREATE" as const, revisionId, terms },
    };
    expect((await resumeChangePdf(mock, pending, () => undefined)).status).toBe(
      "REJECTED",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    const foreign = vi.fn().mockResolvedValue(
      response({
        status: "READY",
        expiresAt,
        canCreateRevision: true,
        extra: "leak",
      }),
    );
    expect(
      (await loadChangePdfStatus(foreign, { jobId, revisionId, mediaAssetId }))
        .status,
    ).toBe("UNAVAILABLE");
    const expired = {
      ...pending,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    expect(
      (await resumeChangePdf(vi.fn(), expired, () => undefined)).status,
    ).toBe("EXPIRED");
  });
});
