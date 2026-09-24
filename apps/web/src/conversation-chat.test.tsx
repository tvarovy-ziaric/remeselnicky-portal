import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationChat,
  ConversationNotice,
  PRE_CONFIRM_CONTACT_WARNING,
  loadConversationTimeline,
  mutateConversation,
  uploadConversationAttachment,
} from "./conversation-chat";

const conversationId = "95100000-0000-4000-8000-000000000001";
const messageId = "95100000-0000-4000-8000-000000000002";
const commandId = "95100000-0000-4000-8000-000000000003";

describe("conversation chat UI boundary", () => {
  it("renders a passive loading state before private timeline hydration", () => {
    const html = renderToStaticMarkup(
      <ConversationChat
        conversation={{
          access: "WRITABLE",
          counterpartDisplayName: "Majster",
          createdAt: "2026-09-15T08:00:00.000Z",
          id: conversationId,
          invitationId: "95100000-0000-4000-8000-000000000004",
          jobRequestId: "95100000-0000-4000-8000-000000000005",
          participantRole: "CUSTOMER",
          requestTitle: "Zákazka",
        }}
      />,
    );
    expect(html).toContain("Načítavam správy");
    expect(html).not.toContain("textarea");
  });

  it("accepts only the exact bounded timeline response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        entries: [entryFixture()],
        hasMore: false,
        nextBeforeSequence: null,
        participantState: {
          archived: false,
          lastReadAt: null,
          lastReadSequence: 0,
          muted: false,
          revision: 0,
        },
        unreadCount: 1,
      }),
    );
    await expect(
      loadConversationTimeline({ conversationId, fetch: fetcher }),
    ).resolves.toMatchObject({ status: "OK" });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/conversations/${conversationId}/timeline`,
      { cache: "no-store", credentials: "same-origin" },
    );

    fetcher.mockResolvedValueOnce(
      Response.json({
        entries: [entryFixture()],
        hasMore: false,
        nextBeforeSequence: null,
        participantState: {
          archived: false,
          lastReadAt: null,
          lastReadSequence: 0,
          muted: false,
          revision: 0,
        },
        storageKey: "private/secret",
        unreadCount: 1,
      }),
    );
    await expect(
      loadConversationTimeline({ conversationId, fetch: fetcher }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("uses session CSRF for sends and maps contact protection", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          { entry: entryFixture(), status: "SENT" },
          { status: 201 },
        ),
      );
    await expect(
      mutateConversation({
        body: "Dobrý deň",
        commandId: () => commandId,
        conversationId,
        fetch: fetcher,
        kind: "MESSAGE",
      }),
    ).resolves.toMatchObject({ status: "MESSAGE_SENT" });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/v1/me/conversations/${conversationId}/messages`,
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf-test",
        },
        method: "POST",
      }),
    );

    const blocked = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          { code: "CONTACT_SHARING_NOT_AVAILABLE" },
          { status: 422 },
        ),
      );
    await expect(
      mutateConversation({
        body: "kontakt@example.sk",
        commandId: () => commandId,
        conversationId,
        fetch: blocked,
        kind: "MESSAGE",
      }),
    ).resolves.toEqual({ status: "CONTACT_BLOCKED" });
  });

  it("renders the pre-confirm warning accessibly without echoing contact text", () => {
    const html = renderToStaticMarkup(
      <ConversationNotice notice={PRE_CONFIRM_CONTACT_WARNING} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("Text zostal v poli");
    expect(html).not.toContain("kontakt@example.sk");
  });

  it("sends only category and message id in a report", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          { reportId: commandId, status: "REPORTED" },
          { status: 201 },
        ),
      );
    await expect(
      mutateConversation({
        commandId: () => commandId,
        conversationId,
        fetch: fetcher,
        kind: "REPORT",
        messageId,
        reason: "ABUSE",
      }),
    ).resolves.toEqual({ status: "REPORTED" });
    const options = fetcher.mock.calls[1]?.[1];
    expect(options?.body).toBe(
      JSON.stringify({ commandId, messageId, reason: "ABUSE" }),
    );
  });

  it("uploads a selected file only to its source message with CSRF", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            assetId: "95100000-0000-4000-8000-000000000006",
            kind: "PDF",
            status: "PROCESSING",
          },
          { status: 202 },
        ),
      );
    const file = new File(["%PDF-1.7\n%%EOF"], "ponuka.pdf", {
      type: "application/pdf",
    });
    await expect(
      uploadConversationAttachment({
        conversationId,
        fetch: fetcher,
        file,
        messageId,
      }),
    ).resolves.toEqual({
      assetId: "95100000-0000-4000-8000-000000000006",
      kind: "PDF",
      status: "UPLOADED",
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/v1/me/conversations/${conversationId}/messages/${messageId}/attachments/documents`,
      expect.objectContaining({
        body: file,
        headers: {
          "content-type": "application/pdf",
          "x-csrf-token": "csrf-test",
        },
        method: "POST",
      }),
    );
  });

  it("rejects corrupt attachment fields and excess photo cardinality", async () => {
    const corrupt = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        entries: [
          {
            ...entryFixture(),
            attachments: Array.from({ length: 6 }, (_, index) => ({
              assetId: `95100000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
              createdAt: "2026-09-15T08:01:01.000Z",
              kind: "IMAGE",
              status: "READY",
            })),
          },
        ],
        hasMore: false,
        nextBeforeSequence: null,
        participantState: {
          archived: false,
          lastReadAt: null,
          lastReadSequence: 0,
          muted: false,
          revision: 0,
        },
        unreadCount: 1,
      }),
    );
    await expect(
      loadConversationTimeline({ conversationId, fetch: corrupt }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });

    corrupt.mockResolvedValueOnce(
      Response.json({
        entries: [
          {
            ...entryFixture(),
            author: "SYSTEM",
            authorRole: null,
            body: null,
            kind: "SYSTEM_EVENT",
            readByCounterpart: null,
            replyToMessageId: null,
            systemEvent: "ENGAGEMENT",
            hiddenByModeration: false,
          },
        ],
        hasMore: false,
        nextBeforeSequence: null,
        participantState: {
          archived: false,
          lastReadAt: null,
          lastReadSequence: 0,
          muted: false,
          revision: 0,
        },
        unreadCount: 0,
      }),
    );
    await expect(
      loadConversationTimeline({ conversationId, fetch: corrupt }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });
});

function entryFixture() {
  return {
    attachments: [
      {
        assetId: "95100000-0000-4000-8000-000000000006",
        createdAt: "2026-09-15T08:01:01.000Z",
        kind: "PDF",
        status: "READY",
      },
    ],
    author: "COUNTERPART",
    authorRole: "CRAFTSMAN",
    body: "Dobrý deň",
    createdAt: "2026-09-15T08:01:00.000Z",
    id: messageId,
    kind: "HUMAN_MESSAGE",
    hiddenByModeration: false,
    readByCounterpart: null,
    replyToMessageId: null,
    sequence: 2,
    systemEvent: null,
  };
}
