"use client";

import React, { useEffect, useState } from "react";
import {
  CONVERSATION_MESSAGE_MAX_ATTACHMENTS,
  CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS,
} from "@portal/domain";

import type { ConversationView } from "./conversation-entry";

export interface ConversationTimelineEntryView {
  readonly attachments: readonly Readonly<{
    readonly assetId: string;
    readonly createdAt: string;
    readonly kind: "IMAGE" | "PDF";
    readonly status: "PROCESSING" | "READY" | "REJECTED";
  }>[];
  readonly author: "COUNTERPART" | "SELF" | "SYSTEM";
  readonly authorRole: "CRAFTSMAN" | "CUSTOMER" | null;
  readonly body: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly kind: "HUMAN_MESSAGE" | "SYSTEM_EVENT";
  readonly hiddenByModeration: boolean;
  readonly readByCounterpart: boolean | null;
  readonly replyToMessageId: string | null;
  readonly sequence: number;
  readonly systemEvent: "ENGAGEMENT" | null;
}

export interface ConversationTimelineView {
  readonly entries: readonly ConversationTimelineEntryView[];
  readonly hasMore: boolean;
  readonly nextBeforeSequence: number | null;
  readonly participantState: {
    readonly archived: boolean;
    readonly lastReadAt: string | null;
    readonly lastReadSequence: number;
    readonly muted: boolean;
    readonly revision: number;
  };
  readonly unreadCount: number;
}

type LoadResult =
  | { readonly status: "NOT_FOUND" | "UNAVAILABLE" }
  | { readonly page: ConversationTimelineView; readonly status: "OK" };

export const PRE_CONFIRM_CONTACT_WARNING =
  "Pred potvrdením zákazky neposielajte telefón, email, sociálny kontakt ani presnú adresu. Text zostal v poli, aby ste ho mohli upraviť.";

export function ConversationChat({
  conversation,
}: {
  readonly conversation: ConversationView;
}) {
  const [result, setResult] = useState<LoadResult | null>(null);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadConversationTimeline({ conversationId: conversation.id }).then(
      (loaded) => {
        if (active) setResult(loaded);
      },
    );
    return () => {
      active = false;
    };
  }, [conversation.id]);

  if (result === null) return <p aria-live="polite">Načítavam správy…</p>;
  if (result.status !== "OK") {
    return <p aria-live="polite">Správy teraz nie sú dostupné.</p>;
  }
  const page = result.page;

  async function send() {
    if (result?.status !== "OK" || body.trim() === "") return;
    setPending(true);
    setNotice(null);
    try {
      const response = await mutateConversation({
        body,
        conversationId: conversation.id,
        kind: "MESSAGE",
      });
      if (response.status === "MESSAGE_SENT") {
        setBody("");
        if (files.length === 0) {
          setResult({
            page: {
              ...result.page,
              entries: [...result.page.entries, response.entry],
            },
            status: "OK",
          });
          return;
        }
        const csrfToken = await loadCsrfToken();
        let uploadFailed = csrfToken === null;
        if (csrfToken !== null) {
          for (const file of files) {
            const uploaded = await uploadConversationAttachment({
              conversationId: conversation.id,
              csrfToken,
              file,
              messageId: response.entry.id,
            });
            if (uploaded.status !== "UPLOADED") uploadFailed = true;
          }
        }
        setFiles([]);
        setFileInputKey((current) => current + 1);
        const refreshed = await loadConversationTimeline({
          conversationId: conversation.id,
        });
        if (refreshed.status === "OK") setResult(refreshed);
        else {
          setResult({
            page: {
              ...result.page,
              entries: [...result.page.entries, response.entry],
            },
            status: "OK",
          });
          uploadFailed = true;
        }
        if (uploadFailed) {
          setNotice(
            "Správa bola odoslaná, ale niektorú prílohu sa nepodarilo pridať. Skúste ju pridať k novej správe.",
          );
        }
      } else {
        setNotice(
          response.status === "CONTACT_BLOCKED"
            ? PRE_CONFIRM_CONTACT_WARNING
            : response.status === "READ_ONLY"
              ? "Konverzácia je už iba na čítanie."
              : "Správu sa nepodarilo odoslať.",
        );
      }
    } finally {
      setPending(false);
    }
  }

  async function update(
    action: "ARCHIVE" | "MARK_READ" | "MUTE" | "UNARCHIVE" | "UNMUTE",
  ) {
    if (result?.status !== "OK") return;
    const last = result.page.entries.at(-1)?.sequence;
    if (action === "MARK_READ" && last === undefined) return;
    setPending(true);
    const response =
      action === "MARK_READ"
        ? await mutateConversation({
            action,
            conversationId: conversation.id,
            expectedRevision: result.page.participantState.revision,
            kind: "STATE",
            readThroughSequence: last as number,
          })
        : await mutateConversation({
            action,
            conversationId: conversation.id,
            expectedRevision: result.page.participantState.revision,
            kind: "STATE",
          });
    setPending(false);
    if (response.status === "STATE_UPDATED") {
      setResult({
        page: {
          ...result.page,
          participantState: response.participantState,
          unreadCount: action === "MARK_READ" ? 0 : result.page.unreadCount,
        },
        status: "OK",
      });
    } else {
      setNotice("Nastavenie sa nepodarilo uložiť. Obnovte konverzáciu.");
    }
  }

  async function report(messageId: string) {
    setPending(true);
    const response = await mutateConversation({
      conversationId: conversation.id,
      kind: "REPORT",
      messageId,
      reason: "ABUSE",
    });
    setPending(false);
    setNotice(
      response.status === "REPORTED"
        ? "Hlásenie bolo prijaté."
        : "Hlásenie sa nepodarilo odoslať.",
    );
  }

  return (
    <section aria-labelledby="conversation-messages">
      <h2 id="conversation-messages">Správy</h2>
      {page.unreadCount > 0 ? (
        <button
          disabled={pending}
          onClick={() => void update("MARK_READ")}
          type="button"
        >
          Označiť ako prečítané ({page.unreadCount})
        </button>
      ) : null}
      <ol className="conversation-timeline">
        {page.entries.map((entry) => (
          <li
            className={`conversation-${entry.author.toLowerCase()}`}
            key={entry.id}
          >
            {entry.kind === "SYSTEM_EVENT" ? (
              <p>
                Remeselník prejavil záujem. Súkromná konverzácia je otvorená.
              </p>
            ) : (
              <article>
                <p className="eyebrow">
                  {entry.author === "SELF" ? "Vy" : "Druhá strana"}
                </p>
                <p>
                  {entry.hiddenByModeration
                    ? "Správa bola skrytá z dôvodu porušenia pravidiel."
                    : linkPlainText(entry.body ?? "")}
                </p>
                {entry.attachments.length === 0 ? null : (
                  <ul aria-label="Prílohy správy">
                    {entry.attachments.map((attachment) => (
                      <li key={attachment.assetId}>
                        {attachment.status === "READY" ? (
                          <a
                            href={`/v1/media/${encodeURIComponent(attachment.assetId)}/download`}
                          >
                            {attachment.kind === "IMAGE"
                              ? "Otvoriť fotografiu"
                              : "Stiahnuť PDF dokument"}
                          </a>
                        ) : attachment.status === "PROCESSING" ? (
                          <span>Príloha sa bezpečne spracúva…</span>
                        ) : (
                          <span>Príloha bola odmietnutá.</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <small>
                  {new Date(entry.createdAt).toLocaleString("sk-SK")}
                  {entry.readByCounterpart === true ? " · Prečítané" : ""}
                </small>
                {entry.author === "COUNTERPART" ? (
                  <button
                    disabled={pending}
                    onClick={() => void report(entry.id)}
                    type="button"
                  >
                    Nahlásiť správu
                  </button>
                ) : null}
              </article>
            )}
          </li>
        ))}
      </ol>
      {conversation.access === "WRITABLE" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="conversation-message">Nová správa</label>
          <textarea
            disabled={pending}
            id="conversation-message"
            maxLength={4_000}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            value={body}
          />
          <label htmlFor="conversation-attachments">
            Fotografie alebo PDF prílohy
          </label>
          <input
            accept="image/jpeg,image/png,image/heic,image/heif,application/pdf"
            disabled={pending}
            id="conversation-attachments"
            key={fileInputKey}
            multiple
            onChange={(event) => {
              const selected = [...(event.target.files ?? [])];
              const imageCount = selected.filter((file) =>
                file.type.startsWith("image/"),
              ).length;
              if (
                selected.length > CONVERSATION_MESSAGE_MAX_ATTACHMENTS ||
                imageCount > CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS
              ) {
                setFiles([]);
                setFileInputKey((current) => current + 1);
                setNotice(
                  "K jednej správe môžete pridať najviac 5 fotografií a 10 príloh spolu.",
                );
                event.target.value = "";
                return;
              }
              setNotice(null);
              setFiles(selected);
            }}
            type="file"
          />
          <small>
            Prílohy sa odošlú až po textovej správe. Video a hlasové správy nie
            sú podporované.
          </small>
          <button disabled={pending || body.trim() === ""} type="submit">
            Odoslať správu
          </button>
        </form>
      ) : null}
      <div className="conversation-controls">
        <button
          disabled={pending}
          onClick={() =>
            void update(page.participantState.muted ? "UNMUTE" : "MUTE")
          }
          type="button"
        >
          {page.participantState.muted
            ? "Zapnúť upozornenia"
            : "Stíšiť upozornenia"}
        </button>
        <button
          disabled={pending}
          onClick={() =>
            void update(
              page.participantState.archived ? "UNARCHIVE" : "ARCHIVE",
            )
          }
          type="button"
        >
          {page.participantState.archived
            ? "Obnoviť z archívu"
            : "Archivovať lokálne"}
        </button>
      </div>
      <ConversationNotice notice={notice} />
    </section>
  );
}

export function ConversationNotice({
  notice,
}: {
  readonly notice: string | null;
}) {
  return notice === null ? null : (
    <p aria-live="assertive" role="alert">
      {notice}
    </p>
  );
}

export async function loadConversationTimeline(input: {
  readonly conversationId: string;
  readonly fetch?: typeof fetch;
}): Promise<LoadResult> {
  if (!uuid(input.conversationId)) return { status: "NOT_FOUND" };
  try {
    const response = await (input.fetch ?? fetch)(
      `/v1/me/conversations/${encodeURIComponent(input.conversationId)}/timeline`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseTimeline(await response.json());
    return page === null ? { status: "UNAVAILABLE" } : { page, status: "OK" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function mutateConversation(
  input:
    | {
        readonly body: string;
        readonly commandId?: () => string;
        readonly conversationId: string;
        readonly fetch?: typeof fetch;
        readonly kind: "MESSAGE";
      }
    | {
        readonly action:
          "ARCHIVE" | "MARK_READ" | "MUTE" | "UNARCHIVE" | "UNMUTE";
        readonly commandId?: () => string;
        readonly conversationId: string;
        readonly expectedRevision: number;
        readonly fetch?: typeof fetch;
        readonly kind: "STATE";
        readonly readThroughSequence?: number;
      }
    | {
        readonly commandId?: () => string;
        readonly conversationId: string;
        readonly fetch?: typeof fetch;
        readonly kind: "REPORT";
        readonly messageId: string;
        readonly reason: "ABUSE";
      },
): Promise<
  | {
      readonly entry: ConversationTimelineEntryView;
      readonly status: "MESSAGE_SENT";
    }
  | {
      readonly participantState: ConversationTimelineView["participantState"];
      readonly status: "STATE_UPDATED";
    }
  | {
      readonly status:
        "CONTACT_BLOCKED" | "READ_ONLY" | "REPORTED" | "UNAVAILABLE";
    }
> {
  if (!uuid(input.conversationId)) return { status: "UNAVAILABLE" };
  const commandId = input.commandId?.() ?? crypto.randomUUID();
  if (!uuid(commandId)) return { status: "UNAVAILABLE" };
  const fetcher = input.fetch ?? fetch;
  try {
    const session = await fetcher("/v1/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!session.ok) return { status: "UNAVAILABLE" };
    const sessionBody: unknown = await session.json();
    if (!record(sessionBody) || typeof sessionBody["csrfToken"] !== "string") {
      return { status: "UNAVAILABLE" };
    }
    const path =
      input.kind === "MESSAGE"
        ? "messages"
        : input.kind === "STATE"
          ? "state"
          : "reports";
    const payload =
      input.kind === "MESSAGE"
        ? { body: input.body, commandId }
        : input.kind === "STATE"
          ? {
              action: input.action,
              commandId,
              expectedRevision: input.expectedRevision,
              ...(input.readThroughSequence === undefined
                ? {}
                : { readThroughSequence: input.readThroughSequence }),
            }
          : { commandId, messageId: input.messageId, reason: input.reason };
    const response = await fetcher(
      `/v1/me/conversations/${encodeURIComponent(input.conversationId)}/${path}`,
      {
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": sessionBody["csrfToken"],
        },
        method: "POST",
      },
    );
    if (response.status === 409) {
      const conflict: unknown = await response.json();
      return record(conflict) && conflict["code"] === "CONVERSATION_READ_ONLY"
        ? { status: "READ_ONLY" }
        : { status: "UNAVAILABLE" };
    }
    if (response.status === 422) return { status: "CONTACT_BLOCKED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const value: unknown = await response.json();
    if (input.kind === "REPORT") return { status: "REPORTED" };
    if (input.kind === "MESSAGE") {
      if (!record(value)) return { status: "UNAVAILABLE" };
      const entry = parseEntry(value["entry"]);
      return entry === null
        ? { status: "UNAVAILABLE" }
        : { entry, status: "MESSAGE_SENT" };
    }
    if (!record(value)) return { status: "UNAVAILABLE" };
    const participantState = parseParticipantState(value["participantState"]);
    return participantState === null
      ? { status: "UNAVAILABLE" }
      : { participantState, status: "STATE_UPDATED" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function uploadConversationAttachment(input: {
  readonly conversationId: string;
  readonly csrfToken?: string;
  readonly fetch?: typeof fetch;
  readonly file: File;
  readonly messageId: string;
}): Promise<
  | Readonly<{ readonly status: "UNAVAILABLE" }>
  | Readonly<{
      readonly assetId: string;
      readonly kind: "IMAGE" | "PDF";
      readonly status: "UPLOADED";
    }>
> {
  if (
    !uuid(input.conversationId) ||
    !uuid(input.messageId) ||
    typeof File === "undefined" ||
    !(input.file instanceof File)
  ) {
    return { status: "UNAVAILABLE" };
  }
  const kind = input.file.type === "application/pdf" ? "PDF" : "IMAGE";
  const allowed =
    kind === "PDF"
      ? input.file.type === "application/pdf"
      : ["image/heic", "image/heif", "image/jpeg", "image/png"].includes(
          input.file.type,
        );
  if (!allowed || input.file.size < 1) return { status: "UNAVAILABLE" };
  try {
    const fetcher = input.fetch ?? fetch;
    const csrfToken = input.csrfToken ?? (await loadCsrfToken(fetcher));
    if (csrfToken === null || csrfToken.length > 1_000) {
      return { status: "UNAVAILABLE" };
    }
    const response = await fetcher(
      `/v1/me/conversations/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.messageId)}/attachments/${kind === "IMAGE" ? "photos" : "documents"}`,
      {
        body: input.file,
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": input.file.type,
          "x-csrf-token": csrfToken,
        },
        method: "POST",
      },
    );
    if (!response.ok) return { status: "UNAVAILABLE" };
    const value: unknown = await response.json();
    if (
      !record(value) ||
      !exactKeys(value, ["assetId", "kind", "status"]) ||
      !uuid(value["assetId"]) ||
      value["kind"] !== kind ||
      value["status"] !== "PROCESSING"
    ) {
      return { status: "UNAVAILABLE" };
    }
    return { assetId: value["assetId"], kind, status: "UPLOADED" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

async function loadCsrfToken(
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const session = await fetcher("/v1/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!session.ok) return null;
    const body: unknown = await session.json();
    return record(body) &&
      typeof body["csrfToken"] === "string" &&
      body["csrfToken"].length >= 1 &&
      body["csrfToken"].length <= 1_000
      ? body["csrfToken"]
      : null;
  } catch {
    return null;
  }
}

function parseTimeline(value: unknown): ConversationTimelineView | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "entries",
      "hasMore",
      "nextBeforeSequence",
      "participantState",
      "unreadCount",
    ]) ||
    !Array.isArray(value["entries"]) ||
    value["entries"].length > 50 ||
    typeof value["hasMore"] !== "boolean" ||
    (value["nextBeforeSequence"] !== null &&
      !positiveInteger(value["nextBeforeSequence"])) ||
    !nonnegativeInteger(value["unreadCount"])
  ) {
    return null;
  }
  const entries = value["entries"].map(parseEntry);
  const participantState = parseParticipantState(value["participantState"]);
  if (entries.some((entry) => entry === null) || participantState === null)
    return null;
  return {
    entries: entries as ConversationTimelineEntryView[],
    hasMore: value["hasMore"],
    nextBeforeSequence: value["nextBeforeSequence"],
    participantState,
    unreadCount: value["unreadCount"],
  };
}

function parseEntry(value: unknown): ConversationTimelineEntryView | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "author",
      "authorRole",
      "attachments",
      "body",
      "createdAt",
      "id",
      "kind",
      "hiddenByModeration",
      "readByCounterpart",
      "replyToMessageId",
      "sequence",
      "systemEvent",
    ]) ||
    !["COUNTERPART", "SELF", "SYSTEM"].includes(String(value["author"])) ||
    !["CRAFTSMAN", "CUSTOMER", null].includes(value["authorRole"] as never) ||
    !uuid(value["id"]) ||
    !validDate(value["createdAt"]) ||
    !positiveInteger(value["sequence"]) ||
    (value["replyToMessageId"] !== null && !uuid(value["replyToMessageId"])) ||
    ![true, false, null].includes(value["readByCounterpart"] as never) ||
    typeof value["hiddenByModeration"] !== "boolean"
  ) {
    return null;
  }
  if (
    !Array.isArray(value["attachments"]) ||
    value["attachments"].length > CONVERSATION_MESSAGE_MAX_ATTACHMENTS
  ) {
    return null;
  }
  const attachments = value["attachments"].map(parseAttachment);
  if (
    attachments.some((attachment) => attachment === null) ||
    attachments.filter((attachment) => attachment?.kind === "IMAGE").length >
      CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS
  ) {
    return null;
  }
  const human = value["kind"] === "HUMAN_MESSAGE";
  if (
    human
      ? (value["hiddenByModeration"]
          ? value["body"] !== null || attachments.length !== 0
          : typeof value["body"] !== "string" ||
            value["body"].length < 1 ||
            value["body"].length > 4_000) ||
        value["systemEvent"] !== null ||
        (value["author"] !== "SELF" && value["author"] !== "COUNTERPART") ||
        (value["authorRole"] !== "CUSTOMER" &&
          value["authorRole"] !== "CRAFTSMAN") ||
        (value["author"] === "COUNTERPART" &&
          value["readByCounterpart"] !== null)
      : value["kind"] !== "SYSTEM_EVENT" ||
        value["body"] !== null ||
        attachments.length !== 0 ||
        value["systemEvent"] !== "ENGAGEMENT" ||
        value["author"] !== "SYSTEM" ||
        value["authorRole"] !== null ||
        value["readByCounterpart"] !== null ||
        value["replyToMessageId"] !== null ||
        value["hiddenByModeration"] !== false
  ) {
    return null;
  }
  return {
    ...(value as unknown as ConversationTimelineEntryView),
    attachments: attachments as ConversationTimelineEntryView["attachments"],
  };
}

function parseAttachment(
  value: unknown,
): ConversationTimelineEntryView["attachments"][number] | null {
  if (
    !record(value) ||
    !exactKeys(value, ["assetId", "createdAt", "kind", "status"]) ||
    !uuid(value["assetId"]) ||
    !validDate(value["createdAt"]) ||
    (value["kind"] !== "IMAGE" && value["kind"] !== "PDF") ||
    !["PROCESSING", "READY", "REJECTED"].includes(String(value["status"]))
  ) {
    return null;
  }
  return value as unknown as ConversationTimelineEntryView["attachments"][number];
}

function parseParticipantState(
  value: unknown,
): ConversationTimelineView["participantState"] | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "archived",
      "lastReadAt",
      "lastReadSequence",
      "muted",
      "revision",
    ]) ||
    typeof value["archived"] !== "boolean" ||
    typeof value["muted"] !== "boolean" ||
    (value["lastReadAt"] !== null && !validDate(value["lastReadAt"])) ||
    !nonnegativeInteger(value["lastReadSequence"]) ||
    !nonnegativeInteger(value["revision"])
  ) {
    return null;
  }
  return value as unknown as ConversationTimelineView["participantState"];
}

function linkPlainText(value: string): React.ReactNode {
  return value.split(/(https?:\/\/[^\s]+)/giu).map((part, index) =>
    /^https?:\/\//iu.test(part) ? (
      <a
        key={`${index}-${part}`}
        href={part}
        rel="nofollow noreferrer"
        target="_blank"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
