import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  commandAttempt,
  loadOperationalPage,
  parseCommentPage,
  parseIssuePage,
  parseProgressPage,
  sendOperationalCommand,
} from "./job-operational-data";
import {
  JobOperationDetail,
  loadJobOperationalDetail,
} from "./job-operation-detail";
import type { JobDocumentItem } from "./job-documentation";
import {
  IssueComments,
  IssueItems,
  JobOperations,
  OperationalMedia,
  ProgressItems,
} from "./job-operations";

const jobId = "94000000-0000-4000-8000-000000000101";
const updateId = "94000000-0000-4000-8000-000000000102";
const issueId = "94000000-0000-4000-8000-000000000103";
const commentId = "94000000-0000-4000-8000-000000000104";
const commandId = "94000000-0000-4000-8000-000000000105";
const photoId = "94000000-0000-4000-8000-000000000106";
const messageId = "94000000-0000-4000-8000-000000000107";
const userId = "94000000-0000-4000-8000-000000000108";
const createdAt = "2026-09-17T12:00:00.000Z";
const photo: JobDocumentItem = {
  mediaAssetId: photoId,
  kind: "PHOTO",
  source: "WINNING_CONVERSATION",
  sourceMessageId: messageId,
  uploadedByUserId: userId,
  authorRole: "PRIMARY_PROVIDER",
  uploadedAt: createdAt,
  capturedAt: null,
  chronologicalAt: createdAt,
  displayFilename: "priebeh.jpg",
  contentType: "image/jpeg",
  downloadPath: `/v1/media/${photoId}/download`,
};
const progress = {
  id: updateId,
  jobId,
  authorDisplayName: "Majster A",
  body: "Práce na streche pokračujú.",
  createdAt,
  acknowledgedAt: null,
  media: [],
};
const issue = {
  id: issueId,
  jobId,
  authorDisplayName: "Zákazník B",
  authorRole: "CUSTOMER",
  kind: "WAITING",
  body: "Čakáme na materiál.",
  createdAt,
  media: [],
};
const comment = {
  id: commentId,
  authorDisplayName: "Majster A",
  authorRole: "PRIMARY_PROVIDER",
  body: "Potvrdzujem objednanie.",
  createdAt,
};

describe("private Job operational records", () => {
  it("accepts exact bounded provenance and rejects cross-Job or surplus private fields", () => {
    expect(
      parseProgressPage(
        { items: [progress], canCreate: true, nextCursor: null },
        jobId,
      )?.items,
    ).toHaveLength(1);
    expect(
      parseProgressPage(
        {
          items: [{ ...progress, jobId: issueId }],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseProgressPage(
        {
          items: [{ ...progress, customerEmail: "private@example.test" }],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseProgressPage(
        {
          items: [{ ...progress, acknowledgedAt: "2026-09-16T12:00:00.000Z" }],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseIssuePage(
        { items: [issue], canCreate: true, nextCursor: null },
        jobId,
      )?.items,
    ).toHaveLength(1);
    expect(
      parseIssuePage(
        {
          items: [{ ...issue, kind: "DISPUTE" }],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseCommentPage({ items: [comment], canCreate: true, nextCursor: null })
        ?.items,
    ).toHaveLength(1);
    expect(
      parseCommentPage({
        items: [{ ...comment, authorRole: "PARTICIPANT" }],
        canCreate: true,
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("requires a valid cursor matching the last returned row", () => {
    expect(
      parseProgressPage(
        {
          items: [progress],
          canCreate: false,
          nextCursor: { id: updateId, createdAt },
        },
        jobId,
      ),
    ).not.toBeNull();
    expect(
      parseProgressPage(
        {
          items: [progress],
          canCreate: false,
          nextCursor: { id: issueId, createdAt },
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseProgressPage(
        {
          items: [],
          canCreate: false,
          nextCursor: { id: updateId, createdAt },
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseProgressPage(
        { items: [progress, progress], canCreate: false, nextCursor: null },
        jobId,
      ),
    ).toBeNull();
  });

  it("accepts only same-origin provenance-rich media, with photo-only progress", () => {
    const withPhoto = { ...progress, media: [photo] };
    expect(
      parseProgressPage(
        { items: [withPhoto], canCreate: true, nextCursor: null },
        jobId,
      ),
    ).not.toBeNull();
    expect(
      parseProgressPage(
        {
          items: [
            {
              ...progress,
              media: [{ ...photo, downloadPath: "https://evil.test/file" }],
            },
          ],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseProgressPage(
        {
          items: [
            {
              ...progress,
              media: [
                { ...photo, downloadPath: `/v1/media/${issueId}/download` },
              ],
            },
          ],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseProgressPage(
        {
          items: [{ ...progress, media: [{ ...photo, source: "UNTRUSTED" }] }],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseProgressPage(
        {
          items: [
            { ...progress, media: [{ ...photo, storageKey: "private/key" }] },
          ],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseProgressPage(
        {
          items: [{ ...progress, media: [photo, photo] }],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    const pdf = {
      ...photo,
      mediaAssetId: issueId,
      kind: "DOCUMENT",
      displayFilename: "problem.pdf",
      contentType: "application/pdf",
      downloadPath: `/v1/media/${issueId}/download`,
    };
    expect(
      parseProgressPage(
        {
          items: [{ ...progress, media: [pdf] }],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseIssuePage(
        {
          items: [{ ...issue, media: [pdf] }],
          canCreate: true,
          nextCursor: null,
        },
        jobId,
      ),
    ).not.toBeNull();
    const html = renderToStaticMarkup(<OperationalMedia media={[photo]} />);
    expect(html).toContain(`src="/v1/media/${photoId}/download"`);
    expect(html).toContain("Z víťaznej konverzácie");
    expect(html).toContain("pridal hlavný poskytovateľ");
  });

  it("sends up to five distinct document IDs without storage keys", async () => {
    const fetcher = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        Response.json(
          url === "/v1/auth/csrf"
            ? { csrfToken: "test" }
            : { status: "APPLIED", id: updateId, createdAt },
        ),
      ),
    );
    expect(
      await sendOperationalCommand({
        fetch: fetcher,
        jobId,
        path: "progress",
        commandId,
        body: "Práce pokračujú.",
        mediaAssetIds: [photoId],
      }),
    ).toBe("OK");
    const body = fetcher.mock.calls[1]?.[1]?.body;
    expect(typeof body === "string" ? JSON.parse(body) : null).toEqual({
      commandId,
      body: "Práce pokračujú.",
      mediaAssetIds: [photoId],
    });
    expect(
      await sendOperationalCommand({
        fetch: fetcher,
        jobId,
        path: "issues",
        commandId,
        kind: "WAITING",
        body: "Čakáme na materiál.",
        mediaAssetIds: [photoId, photoId],
      }),
    ).toBe("UNAVAILABLE");
    expect(
      await sendOperationalCommand({
        fetch: fetcher,
        jobId,
        path: "progress",
        commandId,
        body: "Práce pokračujú.",
        mediaAssetIds: [
          photoId,
          issueId,
          commentId,
          messageId,
          userId,
          updateId,
        ],
      }),
    ).toBe("UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("loads a bounded same-origin page and fails closed on missing authorization", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ items: [issue], canCreate: true, nextCursor: null }),
      ),
    );
    const result = await loadOperationalPage({
      fetch: fetcher,
      kind: "issues",
      jobId,
      cursor: { id: issueId, createdAt },
    });
    expect(result.status).toBe("OK");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain(`/v1/me/jobs/${jobId}/issues?`);
    expect(url).toContain(`beforeId=${issueId}`);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(
      await loadOperationalPage({
        fetch: fetcher,
        kind: "issues",
        jobId: "bad",
      }),
    ).toEqual({ status: "UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const unauthorized = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    expect(
      await loadOperationalPage({
        fetch: unauthorized,
        kind: "progress",
        jobId,
      }),
    ).toEqual({ status: "AUTH_REQUIRED" });
  });

  it("keeps command identity for an uncertain repeat of the same intent", () => {
    const prior = commandAttempt(
      null,
      { kind: "WAITING", body: "abc" },
      () => commandId,
    );
    expect(
      commandAttempt(prior, { kind: "WAITING", body: "abc" }, () => issueId),
    ).toBe(prior);
    expect(
      commandAttempt(prior, { kind: "DELAY", body: "abc" }, () => issueId)
        .commandId,
    ).toBe(issueId);
  });

  it("sends exact CSRF-protected command and validates the result", async () => {
    const fetcher = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        Response.json(
          url === "/v1/auth/csrf"
            ? { csrfToken: "test-csrf" }
            : { status: "APPLIED", id: issueId, createdAt },
        ),
      ),
    );
    expect(
      await sendOperationalCommand({
        fetch: fetcher,
        jobId,
        path: "issues",
        commandId,
        kind: "WAITING",
        body: "Čakáme na materiál.",
      }),
    ).toBe("OK");
    const [path, options] = fetcher.mock.calls[1] ?? [];
    expect(path).toBe(`/v1/me/jobs/${jobId}/issues`);
    expect(options).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "x-csrf-token": "test-csrf" },
    });
    expect(
      typeof options?.body === "string" ? JSON.parse(options.body) : null,
    ).toEqual({ commandId, kind: "WAITING", body: "Čakáme na materiál." });
    expect(
      await sendOperationalCommand({
        fetch: fetcher,
        jobId,
        path: `issues/${issueId}/comments`,
        commandId,
        body: "",
      }),
    ).toBe("UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const malformed = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        Response.json(
          url === "/v1/auth/csrf"
            ? { csrfToken: "test" }
            : { status: "APPLIED", id: issueId, createdAt, secret: "leak" },
        ),
      ),
    );
    expect(
      await sendOperationalCommand({
        fetch: malformed,
        jobId,
        path: "issues",
        commandId,
        kind: "PROBLEM",
        body: "Test",
      }),
    ).toBe("UNAVAILABLE");
    const ack = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        Response.json(
          url === "/v1/auth/csrf"
            ? { csrfToken: "test" }
            : { status: "DEDUPLICATED", acknowledgedAt: createdAt },
        ),
      ),
    );
    expect(
      await sendOperationalCommand({
        fetch: ack,
        jobId,
        path: `progress/${updateId}/acknowledge`,
        commandId,
      }),
    ).toBe("OK");
    const ackOptions = ack.mock.calls[1]?.[1];
    expect(
      typeof ackOptions?.body === "string" ? JSON.parse(ackOptions.body) : null,
    ).toEqual({ commandId });
  });

  it("treats acknowledgment as reading, not commercial consent, and preserves plain-text authorship", () => {
    const parsedProgress = parseProgressPage(
      {
        items: [{ ...progress, body: "<img src=x onerror=alert(1)>" }],
        canCreate: true,
        nextCursor: null,
      },
      jobId,
    );
    expect(parsedProgress).not.toBeNull();
    if (!parsedProgress) return;
    const html = renderToStaticMarkup(
      <ProgressItems items={parsedProgress.items} canAcknowledge={true} />,
    );
    expect(html).toContain("Potvrdiť prečítanie");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    const cancelled = renderToStaticMarkup(
      <JobOperations jobId={jobId} role="CUSTOMER" jobState="CANCELLED" />,
    );
    expect(cancelled).toContain("nie je");
    expect(cancelled).not.toContain("Pridať správu");
    expect(cancelled).not.toContain("Potvrdiť prečítanie");
  });

  it("shows Issue kind, author role and comments as separate records", () => {
    const issues = parseIssuePage(
      { items: [issue], canCreate: true, nextCursor: null },
      jobId,
    );
    const comments = parseCommentPage({
      items: [comment],
      canCreate: true,
      nextCursor: null,
    });
    expect(issues && comments).toBeTruthy();
    if (!issues || !comments) return;
    const html = renderToStaticMarkup(
      <IssueItems items={issues.items} jobId={jobId} jobState="CANCELLED" />,
    );
    expect(html).toContain("Čakanie");
    expect(html).toContain("Zákazník B (Zákazník)");
    expect(
      renderToStaticMarkup(<IssueComments items={comments.items} />),
    ).toContain("Majster A (Hlavný poskytovateľ)");
  });

  it("resolves exact private notification targets and rejects mismatched or malformed records", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(progress)),
    );
    const result = await loadJobOperationalDetail({
      fetch: fetcher,
      jobId,
      itemId: updateId,
      kind: "progress",
    });
    expect(result).toEqual({ status: "OK", item: progress });
    expect(fetcher.mock.calls[0]).toEqual([
      `/v1/me/jobs/${jobId}/progress/${updateId}`,
      { cache: "no-store", credentials: "same-origin" },
    ]);
    expect(
      await loadJobOperationalDetail({
        fetch: fetcher,
        jobId,
        itemId: issueId,
        kind: "progress",
      }),
    ).toEqual({ status: "UNAVAILABLE" });
    const malformed = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ ...issue, exactAddress: "private" })),
    );
    expect(
      await loadJobOperationalDetail({
        fetch: malformed,
        jobId,
        itemId: issueId,
        kind: "issues",
      }),
    ).toEqual({ status: "UNAVAILABLE" });
    expect(
      renderToStaticMarkup(
        <JobOperationDetail jobId={jobId} itemId={updateId} kind="progress" />,
      ),
    ).toContain("Načítava sa súkromný záznam");
  });
});
