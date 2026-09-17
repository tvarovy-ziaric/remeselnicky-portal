import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  JobDocumentList,
  loadJobDocumentPage,
  parseJobDocumentPage,
} from "./job-documentation.js";

const jobId = "86200000-0000-4000-8000-000000000004";
const mediaAssetId = "86200000-0000-4000-8000-000000000006";
const messageId = "86200000-0000-4000-8000-000000000009";
const actorUserId = "86200000-0000-4000-8000-000000000001";
const invitationId = "86200000-0000-4000-8000-000000000005";
const timestamp = "2026-09-16T18:00:00.000Z";
const item = {
  mediaAssetId,
  kind: "PHOTO",
  source: "WINNING_CONVERSATION",
  sourceMessageId: messageId,
  uploadedByUserId: actorUserId,
  authorRole: "CUSTOMER",
  uploadedAt: timestamp,
  capturedAt: timestamp,
  chronologicalAt: timestamp,
  displayFilename: "priebeh.webp",
  contentType: "image/webp",
  downloadPath: `/v1/media/${mediaAssetId}/download`,
};

describe("private Job documentation", () => {
  it("loads a bounded same-origin category and cursor", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ items: [item], nextCursor: null })),
    );
    const result = await loadJobDocumentPage({
      fetch: fetcher,
      jobId,
      category: "PHOTO",
      cursor: { chronologicalAt: timestamp, mediaAssetId },
    });
    expect(result?.items).toHaveLength(1);
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain(`/v1/me/jobs/${jobId}/documentation?`);
    expect(url).toContain("category=PHOTO");
    expect(url).toContain(`beforeId=${mediaAssetId}`);
    expect(options).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("fails closed on cross-object links and malformed provenance", () => {
    expect(
      parseJobDocumentPage({ items: [item], nextCursor: null }),
    ).not.toBeNull();
    expect(
      parseJobDocumentPage({
        items: [{ ...item, downloadPath: "https://evil.test" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseJobDocumentPage({
        items: [{ ...item, sourceMessageId: "bad" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseJobDocumentPage({
        items: [{ ...item, contentType: "application/pdf" }],
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("shows a private preview, author, times and original conversation", () => {
    const parsed = parseJobDocumentPage({ items: [item], nextCursor: null });
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const html = renderToStaticMarkup(
      <JobDocumentList
        items={parsed.items}
        winningInvitationId={invitationId}
      />,
    );
    expect(html).toContain(`src="/v1/media/${mediaAssetId}/download"`);
    expect(html).toContain("Pridal zákazník");
    expect(html).toContain("Zachytené:");
    expect(html).toContain(`/konverzacie/pozvanka/${invitationId}`);
  });
});
