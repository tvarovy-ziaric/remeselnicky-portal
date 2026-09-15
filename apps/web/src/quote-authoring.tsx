"use client";

import React, { useEffect, useState } from "react";

import { loadJobInvitationDetail } from "./job-invitation-detail";

type QuoteAuthoringMode = "EXTERNAL_PDF" | "PLATFORM_STRUCTURED";
type QuoteState =
  | "ACCEPTED"
  | "DRAFT"
  | "EXPIRED"
  | "NOT_SELECTED"
  | "REJECTED"
  | "SUBMITTED"
  | "SUPERSEDED"
  | "WITHDRAWN";

interface QuoteRevisionView {
  readonly authoringMode: QuoteAuthoringMode;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly revision: number;
  readonly state: QuoteState;
  readonly stateRevision: number;
}

interface QuoteView {
  readonly currentDraft: QuoteRevisionView | null;
  readonly currentSubmitted: QuoteRevisionView | null;
  readonly id: string;
  readonly participantRole: "CRAFTSMAN" | "CUSTOMER";
  readonly revisions: readonly QuoteRevisionView[];
}

interface QuoteAuthoringContext {
  readonly invitation: {
    readonly requestContentRevision: number;
    readonly requestVisibleVersion: number;
    readonly state: string;
  };
  readonly quote: QuoteView | null;
  readonly structuredContent: StructuredContentView | null;
}

interface StructuredContentView {
  readonly contentRevision: number;
  readonly priceBasis: string;
  readonly summary: string;
  readonly title: string;
  readonly totalAmountCents: number;
}

export type QuoteAuthoringLoadResult =
  | { readonly context: QuoteAuthoringContext; readonly status: "OK" }
  | {
      readonly status:
        "ACCOUNT_INACTIVE" | "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE";
    };

export function QuoteAuthoring({
  conversationId,
  invitationId,
}: {
  readonly conversationId: string;
  readonly invitationId: string;
}) {
  const [result, setResult] = useState<QuoteAuthoringLoadResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [priceBasis, setPriceBasis] = useState("");
  const [amountEuros, setAmountEuros] = useState("");
  const [contentRevision, setContentRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void loadQuoteAuthoringContext({ invitationId }).then((loaded) => {
      if (!active) return;
      setResult(loaded);
      if (loaded.status === "OK" && loaded.context.structuredContent !== null) {
        const content = loaded.context.structuredContent;
        setContentRevision(content.contentRevision);
        setTitle(content.title);
        setSummary(content.summary);
        setPriceBasis(content.priceBasis);
        setAmountEuros(centsToEuros(content.totalAmountCents));
      }
    });
    return () => {
      active = false;
    };
  }, [invitationId]);

  if (result === null)
    return <p aria-live="polite">Načítavam cenovú ponuku…</p>;
  if (result.status !== "OK")
    return <p aria-live="polite">Cenová ponuka nie je dostupná.</p>;
  const { context } = result;
  if (context.invitation.state !== "ENGAGED") return null;
  const draft = context.quote?.currentDraft ?? null;

  async function createDraft() {
    setPending(true);
    setNotice(null);
    const created = await createStructuredQuoteDraft({
      conversationId,
      requestContentRevision: context.invitation.requestContentRevision,
      requestVisibleVersion: context.invitation.requestVisibleVersion,
    });
    setPending(false);
    if (created.status === "OK") {
      setResult({
        context: {
          ...context,
          quote: created.quote,
          structuredContent: null,
        },
        status: "OK",
      });
    } else {
      setNotice(commandFailure(created.status));
    }
  }

  async function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (context.quote === null || draft === null) return;
    setPending(true);
    setNotice(null);
    const saved = await saveStructuredQuoteDraft({
      amountEuros,
      expectedContentRevision: contentRevision,
      priceBasis,
      quoteId: context.quote.id,
      quoteRevision: draft.revision,
      summary,
      title,
    });
    setPending(false);
    if (saved.status === "OK") {
      setContentRevision(saved.content.contentRevision);
      setResult({
        context: { ...context, structuredContent: saved.content },
        status: "OK",
      });
    }
    setNotice(
      saved.status === "OK"
        ? "Rozpracovaná ponuka je bezpečne uložená."
        : commandFailure(saved.status),
    );
  }

  async function submitDraft() {
    if (context.quote === null || draft === null) return;
    setPending(true);
    setNotice(null);
    const submitted = await submitQuoteDraft({
      expectedDraftStateRevision: draft.stateRevision,
      expectedSubmittedStateRevision:
        context.quote.currentSubmitted?.stateRevision ?? null,
      quoteId: context.quote.id,
      quoteRevision: draft.revision,
    });
    setPending(false);
    if (submitted.status === "OK") {
      setResult({
        context: {
          ...context,
          quote: submitted.quote,
          structuredContent: null,
        },
        status: "OK",
      });
      setNotice("Ponuka bola odoslaná zákazníkovi.");
    } else {
      setNotice(commandFailure(submitted.status));
    }
  }

  return (
    <section aria-labelledby="quote-authoring-heading">
      <h2 id="quote-authoring-heading">Cenová ponuka</h2>
      {context.quote === null ? (
        <>
          <p>
            Vytvorte súkromnú štruktúrovanú ponuku. Zákazník ju uvidí až po
            odoslaní.
          </p>
          <button
            disabled={pending}
            onClick={() => void createDraft()}
            type="button"
          >
            Vytvoriť cenovú ponuku
          </button>
        </>
      ) : draft === null ? (
        <p>
          Aktuálne nemáte rozpracovanú revíziu. Odoslaná obchodná história
          zostáva zachovaná.
        </p>
      ) : draft.authoringMode === "EXTERNAL_PDF" ? (
        <p>
          Táto revízia používa externé PDF. Nahrávanie dokumentu zatiaľ nie je v
          tomto prostredí dostupné.
        </p>
      ) : (
        <form onSubmit={(event) => void saveDraft(event)}>
          <label htmlFor="quote-title">Názov ponuky</label>
          <input
            id="quote-title"
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            required
            value={title}
          />
          <label htmlFor="quote-summary">Zhrnutie realizácie</label>
          <textarea
            id="quote-summary"
            maxLength={2_000}
            onChange={(event) => setSummary(event.target.value)}
            required
            value={summary}
          />
          <label htmlFor="quote-amount">Celková cena v EUR s DPH</label>
          <input
            id="quote-amount"
            inputMode="decimal"
            onChange={(event) => setAmountEuros(event.target.value)}
            pattern="^[0-9]{1,10}([.,][0-9]{1,2})?$"
            required
            value={amountEuros}
          />
          <label htmlFor="quote-price-basis">Čo cena zahŕňa</label>
          <textarea
            id="quote-price-basis"
            maxLength={2_000}
            onChange={(event) => setPriceBasis(event.target.value)}
            required
            value={priceBasis}
          />
          <button disabled={pending} type="submit">
            Uložiť rozpracovanú ponuku
          </button>
          <button
            disabled={pending || contentRevision === 0}
            onClick={() => void submitDraft()}
            type="button"
          >
            Odoslať uloženú ponuku
          </button>
        </form>
      )}
      {notice === null ? null : <p aria-live="polite">{notice}</p>}
    </section>
  );
}

export async function loadQuoteAuthoringContext(input: {
  readonly fetch?: typeof fetch;
  readonly invitationId: string;
}): Promise<QuoteAuthoringLoadResult> {
  if (!uuid(input.invitationId)) return { status: "NOT_FOUND" };
  const fetcher = input.fetch ?? fetch;
  const invitation = await loadJobInvitationDetail({
    fetch: fetcher,
    invitationId: input.invitationId,
  });
  if (invitation.status !== "OK") return invitation;
  if (invitation.invitation.perspective !== "CRAFTSMAN") {
    return { status: "NOT_FOUND" };
  }
  try {
    const response = await fetcher(
      `/v1/me/invitations/${encodeURIComponent(input.invitationId)}/quote`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 403) return { status: "ACCOUNT_INACTIVE" };
    if (response.status === 404)
      return {
        context: {
          invitation: {
            requestContentRevision:
              invitation.invitation.displayedRequestContentRevision,
            requestVisibleVersion:
              invitation.invitation.displayedRequestVisibleVersion,
            state: invitation.invitation.state,
          },
          quote: null,
          structuredContent: null,
        },
        status: "OK",
      };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const quote = parseQuote(await response.json());
    if (quote === null) return { status: "UNAVAILABLE" };
    const structuredContent = await loadCurrentStructuredContent(
      fetcher,
      quote,
    );
    if (structuredContent === undefined) return { status: "UNAVAILABLE" };
    return {
      context: {
        invitation: {
          requestContentRevision:
            invitation.invitation.displayedRequestContentRevision,
          requestVisibleVersion:
            invitation.invitation.displayedRequestVisibleVersion,
          state: invitation.invitation.state,
        },
        quote,
        structuredContent,
      },
      status: "OK",
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

type CommandResult =
  | { readonly quote: QuoteView; readonly status: "OK" }
  | {
      readonly status:
        "AUTH_REQUIRED" | "CONFLICT" | "NOT_FOUND" | "UNAVAILABLE";
    };

export async function createStructuredQuoteDraft(input: {
  readonly commandId?: () => string;
  readonly conversationId: string;
  readonly fetch?: typeof fetch;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}): Promise<CommandResult> {
  if (
    !uuid(input.conversationId) ||
    !positive(input.requestContentRevision) ||
    !positive(input.requestVisibleVersion)
  )
    return { status: "UNAVAILABLE" };
  return postQuote(input.fetch ?? fetch, {
    body: {
      authoringMode: "PLATFORM_STRUCTURED",
      commandId: input.commandId?.() ?? crypto.randomUUID(),
      requestContentRevision: input.requestContentRevision,
      requestVisibleVersion: input.requestVisibleVersion,
    },
    path: `/v1/me/conversations/${encodeURIComponent(input.conversationId)}/quotes`,
  });
}

export async function saveStructuredQuoteDraft(input: {
  readonly amountEuros: string;
  readonly commandId?: () => string;
  readonly expectedContentRevision: number;
  readonly fetch?: typeof fetch;
  readonly priceBasis: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly summary: string;
  readonly title: string;
}): Promise<
  | { readonly content: StructuredContentView; readonly status: "OK" }
  | { readonly status: "CONFLICT" | "UNAVAILABLE" }
> {
  const amountCents = eurosToCents(input.amountEuros);
  if (
    amountCents === null ||
    !uuid(input.quoteId) ||
    !positive(input.quoteRevision) ||
    !nonnegative(input.expectedContentRevision)
  )
    return { status: "UNAVAILABLE" };
  const result = await postJson(input.fetch ?? fetch, {
    body: {
      commandId: input.commandId?.() ?? crypto.randomUUID(),
      content: {
        components: {},
        conditionalOnInspection: false,
        currency: "EUR",
        materialResponsibility: "PROVIDER",
        priceBasis: input.priceBasis,
        priceMode: "FIXED",
        summary: input.summary,
        title: input.title,
        totalAmountCents: amountCents,
        vatStatus: "VAT_INCLUDED",
      },
      expectedContentRevision: input.expectedContentRevision,
    },
    path: `/v1/me/quotes/${encodeURIComponent(input.quoteId)}/revisions/${input.quoteRevision}/structured`,
  });
  if (result.status === 409) return { status: "CONFLICT" };
  if (!result.ok) return { status: "UNAVAILABLE" };
  const value: unknown = await result.json();
  if (
    !record(value) ||
    !exactKeys(value, ["content", "status"]) ||
    !["SAVED", "DEDUPLICATED"].includes(String(value["status"]))
  )
    return { status: "UNAVAILABLE" };
  const content = parseStructuredContent(value["content"]);
  return content === null
    ? { status: "UNAVAILABLE" }
    : { content, status: "OK" };
}

export async function submitQuoteDraft(input: {
  readonly commandId?: () => string;
  readonly expectedDraftStateRevision: number;
  readonly expectedSubmittedStateRevision: number | null;
  readonly fetch?: typeof fetch;
  readonly quoteId: string;
  readonly quoteRevision: number;
}): Promise<CommandResult> {
  if (
    !uuid(input.quoteId) ||
    !positive(input.quoteRevision) ||
    !positive(input.expectedDraftStateRevision) ||
    (input.expectedSubmittedStateRevision !== null &&
      !positive(input.expectedSubmittedStateRevision))
  )
    return { status: "UNAVAILABLE" };
  return postQuote(input.fetch ?? fetch, {
    body: {
      commandId: input.commandId?.() ?? crypto.randomUUID(),
      expectedDraftStateRevision: input.expectedDraftStateRevision,
      expectedSubmittedStateRevision: input.expectedSubmittedStateRevision,
    },
    path: `/v1/me/quotes/${encodeURIComponent(input.quoteId)}/revisions/${input.quoteRevision}/submit`,
  });
}

async function postQuote(
  fetcher: typeof fetch,
  input: { readonly body: object; readonly path: string },
): Promise<CommandResult> {
  const response = await postJson(fetcher, input);
  if (response.status === 401) return { status: "AUTH_REQUIRED" };
  if (response.status === 404) return { status: "NOT_FOUND" };
  if (response.status === 409) return { status: "CONFLICT" };
  if (!response.ok) return { status: "UNAVAILABLE" };
  const value: unknown = await response.json();
  if (
    !record(value) ||
    !["APPLIED", "DEDUPLICATED"].includes(String(value["status"]))
  )
    return { status: "UNAVAILABLE" };
  const quote = parseQuote(value["quote"]);
  return quote === null ? { status: "UNAVAILABLE" } : { quote, status: "OK" };
}

async function postJson(
  fetcher: typeof fetch,
  input: { readonly body: object; readonly path: string },
): Promise<Response> {
  try {
    const session = await fetcher("/v1/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!session.ok) return session;
    const sessionBody: unknown = await session.json();
    if (!record(sessionBody) || typeof sessionBody["csrfToken"] !== "string")
      return new Response(null, { status: 503 });
    return fetcher(input.path, {
      body: JSON.stringify(input.body),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": sessionBody["csrfToken"],
      },
      method: "POST",
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}

function parseQuote(value: unknown): QuoteView | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "conversationId",
      "createdAt",
      "currentDraft",
      "currentSubmitted",
      "id",
      "invitationId",
      "jobRequestId",
      "participantRole",
      "revisions",
    ]) ||
    !uuid(value["id"]) ||
    (value["participantRole"] !== "CRAFTSMAN" &&
      value["participantRole"] !== "CUSTOMER") ||
    !Array.isArray(value["revisions"]) ||
    value["revisions"].length > 100
  )
    return null;
  const revisions = value["revisions"].map(parseRevision);
  const currentDraft = parseNullableRevision(value["currentDraft"]);
  const currentSubmitted = parseNullableRevision(value["currentSubmitted"]);
  if (
    revisions.some((revision) => revision === null) ||
    currentDraft === undefined ||
    currentSubmitted === undefined
  )
    return null;
  return Object.freeze({
    currentDraft,
    currentSubmitted,
    id: value["id"],
    participantRole: value["participantRole"],
    revisions: Object.freeze(revisions as QuoteRevisionView[]),
  });
}

async function loadCurrentStructuredContent(
  fetcher: typeof fetch,
  quote: QuoteView,
): Promise<StructuredContentView | null | undefined> {
  const draft = quote.currentDraft;
  if (draft === null || draft.authoringMode !== "PLATFORM_STRUCTURED") {
    return null;
  }
  const response = await fetcher(
    `/v1/me/quotes/${encodeURIComponent(quote.id)}/revisions/${draft.revision}/structured`,
    { cache: "no-store", credentials: "same-origin" },
  );
  if (response.status === 404) return null;
  if (!response.ok) return undefined;
  return parseStructuredContent(await response.json()) ?? undefined;
}

function parseStructuredContent(value: unknown): StructuredContentView | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "changedAt",
      "components",
      "conditionalOnInspection",
      "contentRevision",
      "currency",
      "depositAmountCents",
      "depositMode",
      "depositNotes",
      "depositPercentageBasisPoints",
      "estimatedDurationDays",
      "estimatedStartOn",
      "excludedScope",
      "includedScope",
      "inspectionConditions",
      "materialResponsibility",
      "priceBasis",
      "priceMode",
      "providerNotes",
      "quoteId",
      "quoteRevision",
      "rangeMaximumCents",
      "rangeMinimumCents",
      "summary",
      "title",
      "totalAmountCents",
      "validUntil",
      "vatStatus",
      "warrantyInformation",
    ]) ||
    !positive(value["contentRevision"]) ||
    !uuid(value["quoteId"]) ||
    !positive(value["quoteRevision"]) ||
    value["currency"] !== "EUR" ||
    value["priceMode"] !== "FIXED" ||
    !positive(value["totalAmountCents"]) ||
    !boundedText(value["title"], 200) ||
    !boundedText(value["summary"], 2_000) ||
    !boundedText(value["priceBasis"], 2_000)
  )
    return null;
  return Object.freeze({
    contentRevision: value["contentRevision"],
    priceBasis: value["priceBasis"],
    summary: value["summary"],
    title: value["title"],
    totalAmountCents: value["totalAmountCents"],
  });
}

function parseNullableRevision(
  value: unknown,
): QuoteRevisionView | null | undefined {
  if (value === null) return null;
  return parseRevision(value) ?? undefined;
}

function parseRevision(value: unknown): QuoteRevisionView | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "authoringMode",
      "changedAt",
      "createdAt",
      "rejectionReason",
      "requestContentRevision",
      "requestVisibleVersion",
      "revision",
      "state",
      "stateRevision",
      "submittedAt",
    ]) ||
    !["EXTERNAL_PDF", "PLATFORM_STRUCTURED"].includes(
      String(value["authoringMode"]),
    ) ||
    ![
      "ACCEPTED",
      "DRAFT",
      "EXPIRED",
      "NOT_SELECTED",
      "REJECTED",
      "SUBMITTED",
      "SUPERSEDED",
      "WITHDRAWN",
    ].includes(String(value["state"])) ||
    !positive(value["revision"]) ||
    !positive(value["stateRevision"]) ||
    !positive(value["requestContentRevision"]) ||
    !positive(value["requestVisibleVersion"])
  )
    return null;
  return {
    authoringMode: value["authoringMode"] as QuoteAuthoringMode,
    requestContentRevision: value["requestContentRevision"],
    requestVisibleVersion: value["requestVisibleVersion"],
    revision: value["revision"],
    state: value["state"] as QuoteState,
    stateRevision: value["stateRevision"],
  };
}

function eurosToCents(value: string): number | null {
  if (!/^\d{1,10}(?:[.,]\d{1,2})?$/u.test(value)) return null;
  const [whole, fraction = ""] = value.replace(",", ".").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function centsToEuros(value: number): string {
  const euros = Math.floor(value / 100);
  const cents = value % 100;
  return cents === 0
    ? String(euros)
    : `${euros}.${String(cents).padStart(2, "0")}`;
}

function commandFailure(status: string): string {
  return status === "CONFLICT"
    ? "Ponuka sa medzičasom zmenila. Obnovte stránku a skúste to znova."
    : "Ponuku sa teraz nepodarilo spracovať.";
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
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
