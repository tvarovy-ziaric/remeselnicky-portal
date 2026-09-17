import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  loadMilestoneContextPage,
  loadMilestoneProposal,
  parseMilestoneCommentPage,
  parseMilestoneMediaPage,
  parseMilestoneProposalPage,
  sendMilestoneContextCommand,
  validMilestoneContextCommand,
} from "./job-milestone-context-data";
import {
  JobMilestoneComments,
  JobMilestoneMedia,
  JobMilestoneProposalDetail,
  JobMilestoneProposals,
  MilestoneCommentItems,
  MilestoneMediaItems,
  MilestoneProposalItems,
} from "./job-milestone-context";

const jobId = "96000000-0000-4000-8000-000000000101";
const otherJobId = "96000000-0000-4000-8000-000000000102";
const milestoneId = "96000000-0000-4000-8000-000000000103";
const proposalId = "96000000-0000-4000-8000-000000000104";
const commentId = "96000000-0000-4000-8000-000000000105";
const linkId = "96000000-0000-4000-8000-000000000106";
const assetId = "96000000-0000-4000-8000-000000000107";
const messageId = "96000000-0000-4000-8000-000000000108";
const userId = "96000000-0000-4000-8000-000000000109";
const commandId = "96000000-0000-4000-8000-000000000110";
const at = "2026-09-17T12:00:00.000Z";
const proposal = {
  id: proposalId,
  jobId,
  targetMilestoneId: milestoneId,
  title: "Nový postup",
  description: "Navrhujem zmeniť poradie.",
  plannedStartOn: "2026-09-21",
  plannedEndOn: "2026-09-23",
  createdAt: at,
  decision: null,
  decidedAt: null,
  appliedMilestoneId: null,
  canDecide: true,
};
const comment = {
  id: commentId,
  milestoneId,
  authorRole: "CUSTOMER",
  body: "Nesúhlasím so stavom.",
  createdAt: at,
};
const media = {
  id: linkId,
  milestoneId,
  mediaAssetId: assetId,
  kind: "PHOTO",
  sourceMessageId: messageId,
  uploadedByUserId: userId,
  uploadedAt: at,
  capturedAt: null,
  displayFilename: "strecha.jpg",
  contentType: "image/jpeg",
  downloadPath: `/v1/media/${assetId}/download`,
  linkedAt: at,
};
const response = (body: unknown, status = 200) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }) as Response;

describe("private milestone context web boundary", () => {
  it("accepts exact same-Job proposals and rejects hidden, inconsistent or oversized fields", () => {
    expect(
      parseMilestoneProposalPage({ items: [proposal], nextCursor: null }, jobId)
        ?.items,
    ).toHaveLength(1);
    expect(
      parseMilestoneProposalPage(
        { items: [{ ...proposal, jobId: otherJobId }], nextCursor: null },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneProposalPage(
        {
          items: [{ ...proposal, baselineEventId: messageId }],
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneProposalPage(
        { items: [{ ...proposal, decision: "ACCEPT" }], nextCursor: null },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneProposalPage(
        {
          items: [{ ...proposal, plannedEndOn: "2026-09-20" }],
          nextCursor: null,
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneProposalPage(
        { items: Array(21).fill(proposal), nextCursor: null },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneProposalPage(
        {
          items: [proposal],
          nextCursor: { beforeAt: at, beforeId: otherJobId },
        },
        jobId,
      ),
    ).toBeNull();
  });

  it("rejects cross-milestone comments and media with unsafe links or provenance", () => {
    expect(
      parseMilestoneCommentPage(
        { items: [comment], nextCursor: null },
        milestoneId,
      )?.items,
    ).toHaveLength(1);
    expect(
      parseMilestoneCommentPage(
        { items: [{ ...comment, milestoneId: otherJobId }], nextCursor: null },
        milestoneId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneCommentPage(
        {
          items: [{ ...comment, authorEmail: "private@example.test" }],
          nextCursor: null,
        },
        milestoneId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneMediaPage({ items: [media], nextCursor: null }, milestoneId)
        ?.items,
    ).toHaveLength(1);
    expect(
      parseMilestoneMediaPage(
        { items: [{ ...media, milestoneId: otherJobId }], nextCursor: null },
        milestoneId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneMediaPage(
        {
          items: [{ ...media, downloadPath: "https://other.test/steal" }],
          nextCursor: null,
        },
        milestoneId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneMediaPage(
        { items: [{ ...media, storageKey: "secret" }], nextCursor: null },
        milestoneId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneMediaPage(
        {
          items: [{ ...media, contentType: "image/svg+xml" }],
          nextCursor: null,
        },
        milestoneId,
      ),
    ).toBeNull();
    expect(
      parseMilestoneMediaPage(
        { items: [media, media], nextCursor: null },
        milestoneId,
      ),
    ).toBeNull();
  });

  it("uses exact-Job no-store reads and rejects 404, alien detail or bad cursor before network", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(response({ items: [proposal], nextCursor: null })),
    );
    const loaded = await loadMilestoneContextPage({
      fetch: fetcher,
      jobId,
      collection: "proposals",
    });
    expect(loaded.status).toBe("OK");
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/jobs/${jobId}/milestone-proposals?limit=20`,
      { cache: "no-store", credentials: "same-origin" },
    );
    const denied = vi.fn(() => Promise.resolve(response({}, 404)));
    expect(
      (
        await loadMilestoneContextPage({
          fetch: denied,
          jobId,
          milestoneId,
          collection: "media",
        })
      ).status,
    ).toBe("NOT_FOUND");
    const alien = vi.fn(() =>
      Promise.resolve(response({ ...proposal, id: otherJobId })),
    );
    expect(
      (await loadMilestoneProposal({ fetch: alien, jobId, proposalId })).status,
    ).toBe("UNAVAILABLE");
    const noNetwork = vi.fn();
    expect(
      (
        await loadMilestoneContextPage({
          fetch: noNetwork,
          jobId,
          milestoneId,
          collection: "comments",
          cursor: { beforeAt: "not-a-time", beforeId: commentId },
        })
      ).status,
    ).toBe("UNAVAILABLE");
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("sends valid idempotent CSRF commands and refuses malformed local input/results", async () => {
    expect(validMilestoneContextCommand({ kind: "PROPOSAL", title: "" })).toBe(
      false,
    );
    expect(
      validMilestoneContextCommand({
        kind: "PROPOSAL",
        title: "Test",
        plannedStartOn: "2026-02-30",
      }),
    ).toBe(false);
    expect(
      validMilestoneContextCommand({
        kind: "MEDIA",
        milestoneId,
        mediaAssetId: "wrong",
      }),
    ).toBe(false);
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      void init;
      return Promise.resolve(
        path === "/v1/auth/csrf"
          ? response({ csrfToken: "token" })
          : response({
              status: "APPLIED",
              id: commandId,
              appliedMilestoneId: milestoneId,
            }),
      );
    });
    const result = await sendMilestoneContextCommand({
      fetch: fetcher as unknown as typeof fetch,
      jobId,
      commandId,
      command: { kind: "DECISION", proposalId, decision: "ACCEPT" },
    });
    expect(result).toEqual({
      status: "OK",
      id: commandId,
      appliedMilestoneId: milestoneId,
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/me/jobs/${jobId}/milestone-proposals/${proposalId}/decision`,
    );
    const post = fetcher.mock.calls[1]?.[1];
    expect(post?.body).toBe(JSON.stringify({ commandId, decision: "ACCEPT" }));
    expect(new Headers(post?.headers).get("x-csrf-token")).toBe("token");
    const bad = vi.fn((path: string) =>
      Promise.resolve(
        path === "/v1/auth/csrf"
          ? response({ csrfToken: "token" })
          : response({ status: "APPLIED", id: proposalId }),
      ),
    );
    expect(
      (
        await sendMilestoneContextCommand({
          fetch: bad as unknown as typeof fetch,
          jobId,
          commandId,
          command: { kind: "COMMENT", milestoneId, body: "Poznámka" },
        })
      ).status,
    ).toBe("UNAVAILABLE");
  });

  it("renders context without raw source/actor IDs or payment state", () => {
    const parsedProposals = parseMilestoneProposalPage(
      { items: [proposal], nextCursor: null },
      jobId,
    );
    const parsedComments = parseMilestoneCommentPage(
      { items: [comment], nextCursor: null },
      milestoneId,
    );
    const parsedMedia = parseMilestoneMediaPage(
      { items: [media], nextCursor: null },
      milestoneId,
    );
    expect(parsedProposals && parsedComments && parsedMedia).toBeTruthy();
    const proposals = renderToStaticMarkup(
      <MilestoneProposalItems
        items={parsedProposals!.items}
        jobId={jobId}
        pending={false}
      />,
    );
    const comments = renderToStaticMarkup(
      <MilestoneCommentItems items={parsedComments!.items} />,
    );
    const files = renderToStaticMarkup(
      <MilestoneMediaItems items={parsedMedia!.items} />,
    );
    expect(proposals).toContain("Čaká na rozhodnutie");
    expect(proposals).not.toContain("Prijať prevádzkový návrh");
    expect(comments).toContain("Zákazník");
    expect(files).toContain(`/v1/media/${assetId}/download`);
    expect(files).not.toContain(userId);
    expect(files).not.toContain(messageId);
    expect(files).not.toContain("Zaplatené");
    expect(
      renderToStaticMarkup(
        <JobMilestoneProposals
          jobId={jobId}
          role="CUSTOMER"
          jobState="CONFIRMED"
          milestones={[]}
        />,
      ),
    ).not.toContain("Navrhovaný názov");
    expect(
      renderToStaticMarkup(
        <JobMilestoneComments jobId={jobId} milestoneId={milestoneId} />,
      ),
    ).not.toContain("Pridať komentár");
    expect(
      renderToStaticMarkup(
        <JobMilestoneMedia jobId={jobId} milestoneId={milestoneId} />,
      ),
    ).not.toContain("Súkromné súbory zákazky");
    const detail = renderToStaticMarkup(
      <JobMilestoneProposalDetail jobId={jobId} proposalId={proposalId} />,
    );
    expect(detail).toContain("Načítava sa súkromný návrh");
    expect(detail).not.toContain(proposal.title);
  });
});
