"use client";

import {
  QUOTE_COMPARISON_MISSING_LABEL,
  type QuoteComparisonCard,
} from "@portal/domain";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import {
  loadJobInvitationDetail,
  type InvitationDetailView,
} from "./job-invitation-detail";
import { loadQuoteComparison } from "./quote-comparison";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const conversationPath = /^\/konverzacie\/pozvanka\/([0-9a-f-]{36})$/iu;

export type AcceptanceRecapLoadResult =
  | { readonly status: "NOT_FOUND" | "UNAVAILABLE" }
  | {
      readonly invitation: InvitationDetailView;
      readonly location: AcceptanceLocationSnapshot;
      readonly quote: QuoteComparisonCard;
      readonly quoteStateRevision: number;
      readonly requestContentRevision: number;
      readonly requestVisibleVersion: number;
      readonly status: "OK";
      readonly supportingDocuments: readonly AcceptanceSupportingDocument[];
      readonly csrfToken: string;
      readonly userId: string;
    };

export interface AcceptanceLocationSnapshot {
  readonly exactAddress: string | null;
  readonly mapPin: {
    readonly latitude: number;
    readonly longitude: number;
  } | null;
  readonly municipalityCode: string;
  readonly textClarification: string | null;
}

export interface AcceptanceSupportingDocument {
  readonly attachedAt: string;
  readonly downloadPath: string;
  readonly mediaAssetId: string;
}

export async function loadAcceptanceRecap(input: {
  readonly fetch: typeof fetch;
  readonly jobRequestId: string;
  readonly quoteId: string;
}): Promise<AcceptanceRecapLoadResult> {
  if (!uuid.test(input.jobRequestId) || !uuid.test(input.quoteId)) {
    return { status: "NOT_FOUND" };
  }
  const comparison = await loadQuoteComparison({
    fetch: input.fetch,
    jobRequestId: input.jobRequestId,
  });
  if (comparison.status !== "OK") return { status: comparison.status };
  const quote = comparison.comparison.items.find(
    (item) => item.quoteId === input.quoteId,
  );
  if (quote === undefined) return { status: "NOT_FOUND" };
  const invitationId = conversationPath.exec(quote.conversationPath)?.[1];
  if (invitationId === undefined || !uuid.test(invitationId)) {
    return { status: "UNAVAILABLE" };
  }
  let context: unknown;
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/quotes/${input.quoteId}/lifecycle?quoteRevision=${quote.quoteRevision}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    context = await response.json();
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (
    !recapContext(context) ||
    context.quoteId !== input.quoteId ||
    context.quoteRevision !== quote.quoteRevision ||
    context.state !== "SUBMITTED" ||
    context.lifecycleAcceptanceEligible !== quote.lifecycleAcceptanceEligible ||
    context.materiallyStale !== quote.materiallyStale ||
    context.deadlinePassed
  ) {
    return { status: "UNAVAILABLE" };
  }
  let invitationResult: Awaited<ReturnType<typeof loadJobInvitationDetail>>;
  let sessionResponse: Response;
  let supportingResponse: Response;
  let versionResponse: Response;
  try {
    [invitationResult, sessionResponse, supportingResponse, versionResponse] =
      await Promise.all([
        loadJobInvitationDetail({
          fetch: input.fetch,
          invitationId,
          requestContentRevision: context.requestContentRevision,
        }),
        input.fetch.call(globalThis, "/v1/auth/session", {
          cache: "no-store",
          credentials: "same-origin",
        }),
        input.fetch.call(
          globalThis,
          `/v1/me/quotes/${input.quoteId}/revisions/${quote.quoteRevision}/supporting-documents`,
          { cache: "no-store", credentials: "same-origin" },
        ),
        input.fetch.call(
          globalThis,
          `/v1/me/job-requests/${input.jobRequestId}/versions/${context.requestContentRevision}`,
          { cache: "no-store", credentials: "same-origin" },
        ),
      ]);
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (invitationResult.status === "NOT_FOUND") return { status: "NOT_FOUND" };
  if (
    invitationResult.status !== "OK" ||
    !sessionResponse.ok ||
    !supportingResponse.ok ||
    !versionResponse.ok
  ) {
    return { status: "UNAVAILABLE" };
  }
  let session: unknown;
  let supportingPayload: unknown;
  let versionPayload: unknown;
  try {
    session = (await sessionResponse.json()) as unknown;
    supportingPayload = (await supportingResponse.json()) as unknown;
    versionPayload = (await versionResponse.json()) as unknown;
  } catch {
    return { status: "UNAVAILABLE" };
  }
  const userId = sessionUserId(session);
  const csrfToken = sessionCsrfToken(session);
  const supportingDocuments = parseSupportingDocuments(supportingPayload);
  const location = parseLocationSnapshot(versionPayload, {
    jobRequestId: input.jobRequestId,
    contentRevision: context.requestContentRevision,
    visibleVersion: context.requestVisibleVersion,
  });
  if (
    userId === null ||
    csrfToken === null ||
    supportingDocuments === null ||
    location === null ||
    location.municipalityCode !==
      invitationResult.invitation.request.municipalityCode ||
    invitationResult.invitation.perspective !== "CUSTOMER" ||
    invitationResult.invitation.jobRequestId !== input.jobRequestId ||
    invitationResult.invitation.id !== invitationId ||
    invitationResult.invitation.displayedRequestContentRevision !==
      context.requestContentRevision ||
    invitationResult.invitation.displayedRequestVisibleVersion !==
      context.requestVisibleVersion
  ) {
    return { status: "UNAVAILABLE" };
  }
  return {
    csrfToken,
    invitation: invitationResult.invitation,
    location,
    quote,
    quoteStateRevision: context.stateRevision,
    requestContentRevision: context.requestContentRevision,
    requestVisibleVersion: context.requestVisibleVersion,
    status: "OK",
    supportingDocuments,
    userId,
  };
}

function parseSupportingDocuments(
  value: unknown,
): readonly AcceptanceSupportingDocument[] | null {
  if (typeof value !== "object" || value === null || !("documents" in value)) {
    return null;
  }
  const documents = value.documents;
  if (!Array.isArray(documents) || documents.length > 50) return null;
  const unique = new Set<string>();
  const parsed: AcceptanceSupportingDocument[] = [];
  for (const document of documents) {
    if (typeof document !== "object" || document === null) return null;
    const item = document as Record<string, unknown>;
    if (
      typeof item["mediaAssetId"] !== "string" ||
      !uuid.test(item["mediaAssetId"]) ||
      typeof item["downloadPath"] !== "string" ||
      item["downloadPath"] !== `/v1/media/${item["mediaAssetId"]}/download` ||
      typeof item["attachedAt"] !== "string" ||
      !Number.isFinite(Date.parse(item["attachedAt"])) ||
      unique.has(item["mediaAssetId"])
    ) {
      return null;
    }
    unique.add(item["mediaAssetId"]);
    parsed.push({
      attachedAt: item["attachedAt"],
      downloadPath: item["downloadPath"],
      mediaAssetId: item["mediaAssetId"],
    });
  }
  return Object.freeze(parsed);
}

function recapContext(value: unknown): value is {
  readonly deadlinePassed: boolean;
  readonly lifecycleAcceptanceEligible: boolean;
  readonly materiallyStale: boolean;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly stateRevision: number;
  readonly state: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const context = value as Record<string, unknown>;
  return (
    typeof context["deadlinePassed"] === "boolean" &&
    typeof context["lifecycleAcceptanceEligible"] === "boolean" &&
    typeof context["materiallyStale"] === "boolean" &&
    typeof context["quoteId"] === "string" &&
    uuid.test(context["quoteId"]) &&
    Number.isSafeInteger(context["quoteRevision"]) &&
    (context["quoteRevision"] as number) > 0 &&
    Number.isSafeInteger(context["requestContentRevision"]) &&
    (context["requestContentRevision"] as number) > 0 &&
    Number.isSafeInteger(context["requestVisibleVersion"]) &&
    (context["requestVisibleVersion"] as number) > 0 &&
    Number.isSafeInteger(context["stateRevision"]) &&
    (context["stateRevision"] as number) > 0 &&
    typeof context["state"] === "string"
  );
}

export function QuoteAcceptanceRecap({
  jobRequestId,
  quoteId,
}: {
  readonly jobRequestId: string;
  readonly quoteId: string;
}) {
  const [result, setResult] = useState<AcceptanceRecapLoadResult | null>(null);
  useEffect(() => {
    let active = true;
    void loadAcceptanceRecap({ fetch, jobRequestId, quoteId }).then((next) => {
      if (active) setResult(next);
    });
    return () => {
      active = false;
    };
  }, [jobRequestId, quoteId]);
  if (result === null) return <p role="status">Načítavam rekapituláciu…</p>;
  if (result.status !== "OK") {
    return (
      <p role="alert">Táto ponuka nie je dostupná na záverečnú kontrolu.</p>
    );
  }
  return <QuoteAcceptanceRecapView {...result} />;
}

export type AcceptanceSubmissionResult =
  | { readonly jobId: string; readonly status: "APPLIED" | "DEDUPLICATED" }
  | { readonly status: "AUTH_REQUIRED" | "CONFLICT" | "UNAVAILABLE" };

export async function submitQuoteAcceptance(input: {
  readonly commandId: string;
  readonly csrfToken: string;
  readonly expectedQuoteStateRevision: number;
  readonly expectedRequestContentRevision: number;
  readonly expectedRequestVisibleVersion: number;
  readonly fetch: typeof fetch;
  readonly finalExactAddress?: string;
  readonly jobRequestId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
}): Promise<AcceptanceSubmissionResult> {
  if (
    !uuid.test(input.commandId) ||
    !uuid.test(input.jobRequestId) ||
    !uuid.test(input.quoteId) ||
    input.csrfToken.length === 0 ||
    [
      input.expectedQuoteStateRevision,
      input.expectedRequestContentRevision,
      input.expectedRequestVisibleVersion,
      input.quoteRevision,
    ].some((revision) => !Number.isSafeInteger(revision) || revision < 1) ||
    (input.finalExactAddress !== undefined &&
      (input.finalExactAddress.trim() !== input.finalExactAddress ||
        input.finalExactAddress.length < 1 ||
        input.finalExactAddress.length > 500))
  )
    return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-requests/${input.jobRequestId}/quotes/${input.quoteId}/accept`,
      {
        body: JSON.stringify({
          commandId: input.commandId,
          explicitlyConfirmed: true,
          expectedQuoteStateRevision: input.expectedQuoteStateRevision,
          expectedRequestContentRevision: input.expectedRequestContentRevision,
          expectedRequestVisibleVersion: input.expectedRequestVisibleVersion,
          ...(input.finalExactAddress === undefined
            ? {}
            : { finalExactAddress: input.finalExactAddress }),
          quoteRevision: input.quoteRevision,
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": input.csrfToken,
        },
        method: "POST",
      },
    );
    if (response.status === 401 || response.status === 403)
      return { status: "AUTH_REQUIRED" };
    if (response.status === 409) return { status: "CONFLICT" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null)
      return { status: "UNAVAILABLE" };
    const result = body as Record<string, unknown>;
    if (
      (result["status"] !== "APPLIED" && result["status"] !== "DEDUPLICATED") ||
      typeof result["jobId"] !== "string" ||
      !uuid.test(result["jobId"])
    )
      return { status: "UNAVAILABLE" };
    return {
      jobId: result["jobId"],
      status: result["status"],
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function QuoteAcceptanceRecapView({
  csrfToken,
  invitation,
  location,
  quote,
  quoteStateRevision,
  requestContentRevision,
  requestVisibleVersion,
  supportingDocuments,
  userId,
}: Extract<AcceptanceRecapLoadResult, { status: "OK" }>) {
  const [finalExactAddress, setFinalExactAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [acceptedJobId, setAcceptedJobId] = useState<string | null>(null);
  const retry = useRef<{
    readonly address: string;
    readonly commandId: string;
  } | null>(null);

  const confirm = async () => {
    if (
      pending ||
      acceptedJobId !== null ||
      !quote.lifecycleAcceptanceEligible ||
      quote.materiallyStale
    )
      return;
    const address = finalExactAddress.trim();
    if (address.length > 500) {
      setNotice("Presná adresa môže mať najviac 500 znakov.");
      return;
    }
    setPending(true);
    setNotice("");
    if (retry.current?.address !== address)
      retry.current = { address, commandId: crypto.randomUUID() };
    const result = await submitQuoteAcceptance({
      commandId: retry.current.commandId,
      csrfToken,
      expectedQuoteStateRevision: quoteStateRevision,
      expectedRequestContentRevision: requestContentRevision,
      expectedRequestVisibleVersion: requestVisibleVersion,
      fetch,
      ...(address === "" ? {} : { finalExactAddress: address }),
      jobRequestId: invitation.jobRequestId,
      quoteId: quote.quoteId,
      quoteRevision: quote.quoteRevision,
    });
    setPending(false);
    if (result.status === "APPLIED" || result.status === "DEDUPLICATED") {
      setAcceptedJobId(result.jobId);
      return;
    }
    setNotice(
      result.status === "CONFLICT"
        ? "Ponuka alebo dopyt sa zmenili. Obnovte rekapituláciu a skontrolujte aktuálny stav."
        : result.status === "AUTH_REQUIRED"
          ? "Prihlásenie vypršalo. Prihláste sa znova a skontrolujte stav dopytu."
          : "Potvrdenie sa nepodarilo overiť. Skontrolujte stav dopytu a skúste to znova.",
    );
  };
  if (acceptedJobId !== null)
    return (
      <main className="invitation-detail quote-acceptance-recap">
        <p className="eyebrow">Zákazka</p>
        <h1>Zákazka je potvrdená</h1>
        <p>
          Vaše potvrdenie bolo zaznamenané. Identifikátor zákazky:{" "}
          {acceptedJobId}
        </p>
        <p>
          <Link href={`/zakazky/${acceptedJobId}`}>
            Otvoriť zákazku a prijatú dohodu
          </Link>
        </p>
        <p>
          <Link href={quote.conversationPath}>
            Pokračovať v konverzácii s remeselníkom
          </Link>
        </p>
      </main>
    );
  return (
    <article
      className="invitation-detail quote-acceptance-recap"
      aria-labelledby="acceptance-recap-title"
    >
      <header>
        <p className="eyebrow">Záverečná kontrola</p>
        <h1 id="acceptance-recap-title">Rekapitulácia vybranej ponuky</h1>
        <p>
          Táto obrazovka nič nepotvrdzuje, nemení ponuku a nerezervuje kapacitu
          remeselníka.
        </p>
      </header>
      {quote.materiallyStale || !quote.lifecycleAcceptanceEligible ? (
        <p role="alert">
          Túto ponuku teraz nemožno prijať. Môže byť neaktuálna, expirovaná
          alebo stiahnutá; remeselník musí podľa stavu poslať alebo potvrdiť
          aktuálnu revíziu.
        </p>
      ) : null}
      <section aria-labelledby="recap-parties">
        <h2 id="recap-parties">Strany</h2>
        <dl>
          <Fact label="Remeselník" value={quote.provider.displayName} />
          <Fact
            label="Identita remeselníka"
            value={
              quote.provider.identityVerified
                ? "Overená platformou"
                : "Neoverená platformou"
            }
          />
          <Fact label="Zákazník" value={`Prihlásené konto ${userId}`} />
        </dl>
      </section>
      <section aria-labelledby="recap-work">
        <h2 id="recap-work">Práca a rozsah</h2>
        <h3>{invitation.request.title}</h3>
        <p>{invitation.request.description}</p>
        <p>Verzia dopytu: {invitation.displayedRequestVisibleVersion}</p>
        <p>Revízia ponuky: {quote.quoteRevision}</p>
        <dl>
          <Fact label="Obec" value={invitation.request.municipalityCode} />
          <Fact
            label="Presná adresa práce"
            value={location.exactAddress ?? "Nie je uvedená"}
          />
          {location.textClarification === null ? null : (
            <Fact
              label="Spresnenie miesta"
              value={location.textClarification}
            />
          )}
        </dl>
        {invitation.request.details.customRequirements === null ? null : (
          <p>{invitation.request.details.customRequirements}</p>
        )}
        <h3>Zahrnuté práce</h3>
        <Scope items={quote.includedScope} />
        <h3>Nezahrnuté práce</h3>
        <Scope items={quote.excludedScope} />
        {quote.details === null ? null : (
          <>
            <h3>{quote.details.title}</h3>
            <p>{quote.details.summary}</p>
            <dl>
              <Fact label="Cenový základ" value={quote.details.priceBasis} />
              <Fact
                label="Práca"
                value={terms(
                  quote.details.components.labor.amountCents,
                  quote.details.components.labor.description,
                )}
              />
              <Fact
                label="Materiálové náklady"
                value={terms(
                  quote.details.components.material.amountCents,
                  quote.details.components.material.description,
                )}
              />
              <Fact
                label="Ostatné náklady"
                value={terms(
                  quote.details.components.other.amountCents,
                  quote.details.components.other.description,
                )}
              />
            </dl>
          </>
        )}
        <dl>
          <Fact label="Obhliadka" value={inspection(quote)} />
        </dl>
      </section>
      <section aria-labelledby="recap-terms">
        <h2 id="recap-terms">Cena a podmienky</h2>
        {quote.price.mode === "FIXED" ? null : (
          <p role="alert">
            Toto nie je pevná konečná cena; ide o odhad alebo cenový rozsah.
          </p>
        )}
        <dl>
          <Fact label="Cena" value={price(quote)} />
          <Fact label="Režim ceny" value={priceMode(quote.price.mode)} />
          <Fact label="DPH" value={vat(quote.price.vatStatus)} />
          <Fact label="Záloha" value={deposit(quote)} />
          <Fact
            label="Platnosť ponuky"
            value={
              quote.validUntil === null
                ? QUOTE_COMPARISON_MISSING_LABEL
                : new Date(quote.validUntil).toLocaleDateString("sk-SK")
            }
          />
          <Fact
            label="Plánovaný začiatok"
            value={quote.estimatedStartOn ?? QUOTE_COMPARISON_MISSING_LABEL}
          />
          <Fact
            label="Trvanie"
            value={
              quote.estimatedDurationDays === null
                ? QUOTE_COMPARISON_MISSING_LABEL
                : `${quote.estimatedDurationDays} dní`
            }
          />
          <Fact
            label="Materiál"
            value={material(quote.materialResponsibility)}
          />
          <Fact
            label="Doprava"
            value={terms(quote.travelAmountCents, quote.travelDescription)}
          />
          <Fact
            label="Záruka"
            value={quote.warrantyInformation ?? QUOTE_COMPARISON_MISSING_LABEL}
          />
        </dl>
        {quote.authoringMode === "EXTERNAL_PDF" ? (
          <p>
            Podrobným obchodným dokumentom je priložené PDF. Štruktúrovaný súhrn
            je potvrdený remeselníkom na porovnanie; pred potvrdením si
            prečítajte PDF aj súhrn.
          </p>
        ) : (
          <p>
            Záväzným obchodným obsahom je presná revízia štruktúrovanej ponuky.
            Konverzácia ju sama nemení.
          </p>
        )}
        {quote.pdfDownloadPath === null ? null : (
          <p>
            <a href={quote.pdfDownloadPath}>Otvoriť priložené PDF</a>
          </p>
        )}
      </section>
      <section aria-labelledby="recap-supporting-documents">
        <h2 id="recap-supporting-documents">Podporné dokumenty ponuky</h2>
        <p>
          Tieto dokumenty remeselník výslovne zahrnul do tejto revízie ponuky.
          Pred potvrdením si ich otvorte spolu s cenou a rozsahom práce.
        </p>
        {supportingDocuments.length === 0 ? (
          <p>Táto revízia nemá ďalšie podporné dokumenty.</p>
        ) : (
          <ol>
            {supportingDocuments.map((document, index) => (
              <li key={document.mediaAssetId}>
                <a href={document.downloadPath}>
                  Podporný dokument {index + 1} (PDF)
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>
      {location.exactAddress === null ? (
        <p>
          <label htmlFor="final-exact-address">
            Presná adresa práce, ak je potrebná
          </label>
          <input
            autoComplete="street-address"
            id="final-exact-address"
            maxLength={500}
            onChange={(event) => setFinalExactAddress(event.target.value)}
            value={finalExactAddress}
          />
          Remeselník ju uvidí až po vytvorení zákazky. Obec sa tu nedá zmeniť.
        </p>
      ) : null}
      <p>Potvrdením prijímate presne túto revíziu ponuky a vznikne zákazka.</p>
      {notice === "" ? null : <p role="alert">{notice}</p>}
      <p>
        <button
          type="button"
          disabled={
            pending ||
            quote.materiallyStale ||
            !quote.lifecycleAcceptanceEligible
          }
          onClick={() => void confirm()}
        >
          {pending ? "Potvrdzujem…" : "Potvrdiť ponuku a vytvoriť zákazku"}
        </button>
      </p>
      <p>
        <Link href={`/ziadosti/${invitation.jobRequestId}/ponuky`}>
          Späť na porovnanie
        </Link>
      </p>
    </article>
  );
}

function sessionUserId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("user" in value)) {
    return null;
  }
  const user = value.user;
  if (typeof user !== "object" || user === null || !("id" in user)) {
    return null;
  }
  return typeof user.id === "string" && uuid.test(user.id) ? user.id : null;
}

function sessionCsrfToken(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("csrfToken" in value))
    return null;
  return typeof value.csrfToken === "string" && value.csrfToken.length > 0
    ? value.csrfToken
    : null;
}

function parseLocationSnapshot(
  value: unknown,
  expected: {
    readonly jobRequestId: string;
    readonly contentRevision: number;
    readonly visibleVersion: number;
  },
): AcceptanceLocationSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as Record<string, unknown>;
  const version = result["version"];
  const sections = result["sections"];
  if (
    typeof version !== "object" ||
    version === null ||
    !Array.isArray(sections) ||
    sections.length > 12
  )
    return null;
  const revision = version as Record<string, unknown>;
  if (
    revision["jobRequestId"] !== expected.jobRequestId ||
    revision["contentRevision"] !== expected.contentRevision ||
    revision["visibleVersion"] !== expected.visibleVersion
  )
    return null;
  const locations = sections.filter(
    (section) =>
      typeof section === "object" &&
      section !== null &&
      (section as Record<string, unknown>)["key"] === "request.location",
  );
  if (locations.length !== 1) return null;
  const section = locations[0] as Record<string, unknown>;
  if (section["schemaVersion"] !== 1) return null;
  const payload = section["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const location = payload as Record<string, unknown>;
  const address = location["exactAddress"];
  const clarification = location["textClarification"];
  const pin = location["mapPin"];
  if (
    typeof location["municipalityCode"] !== "string" ||
    location["municipalityCode"].length === 0 ||
    (address !== null &&
      address !== undefined &&
      typeof address !== "string") ||
    (typeof address === "string" &&
      (address.length < 1 || address.length > 500)) ||
    (clarification !== null &&
      clarification !== undefined &&
      typeof clarification !== "string") ||
    (typeof clarification === "string" &&
      (clarification.length < 1 || clarification.length > 1000)) ||
    (pin !== null && pin !== undefined && typeof pin !== "object")
  )
    return null;
  let mapPin: AcceptanceLocationSnapshot["mapPin"] = null;
  if (pin !== null && pin !== undefined) {
    const coordinates = pin as Record<string, unknown>;
    if (
      Object.keys(coordinates).sort().join(",") !== "latitude,longitude" ||
      typeof coordinates["latitude"] !== "number" ||
      typeof coordinates["longitude"] !== "number" ||
      !Number.isFinite(coordinates["latitude"]) ||
      !Number.isFinite(coordinates["longitude"]) ||
      coordinates["latitude"] < -90 ||
      coordinates["latitude"] > 90 ||
      coordinates["longitude"] < -180 ||
      coordinates["longitude"] > 180
    )
      return null;
    mapPin = {
      latitude: coordinates["latitude"],
      longitude: coordinates["longitude"],
    };
  }
  return {
    exactAddress: address ?? null,
    mapPin,
    municipalityCode: location["municipalityCode"],
    textClarification: clarification ?? null,
  };
}

function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
function Scope({ items }: { readonly items: readonly string[] | null }) {
  return items === null || items.length === 0 ? (
    <p>{QUOTE_COMPARISON_MISSING_LABEL}</p>
  ) : (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
function euro(cents: number): string {
  return new Intl.NumberFormat("sk-SK", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}
function price(quote: QuoteComparisonCard): string {
  if (quote.price.mode === "RANGE") {
    return quote.price.rangeMinimumCents === null ||
      quote.price.rangeMaximumCents === null
      ? QUOTE_COMPARISON_MISSING_LABEL
      : `${euro(quote.price.rangeMinimumCents)} – ${euro(quote.price.rangeMaximumCents)}`;
  }
  return quote.price.totalAmountCents === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : euro(quote.price.totalAmountCents);
}
function priceMode(mode: QuoteComparisonCard["price"]["mode"]): string {
  return mode === "FIXED"
    ? "Pevná cena"
    : mode === "ESTIMATE"
      ? "Odhad"
      : "Cenový rozsah";
}
function vat(status: QuoteComparisonCard["price"]["vatStatus"]): string {
  return status === "VAT_INCLUDED"
    ? "DPH zahrnutá"
    : status === "VAT_EXCLUDED"
      ? "Bez DPH"
      : "Neplatca DPH";
}
function deposit(quote: QuoteComparisonCard): string {
  return quote.deposit.mode === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : quote.deposit.mode === "NONE"
      ? "Bez zálohy"
      : quote.deposit.mode === "FIXED_AMOUNT" &&
          quote.deposit.amountCents !== null
        ? euro(quote.deposit.amountCents)
        : quote.deposit.percentageBasisPoints === null
          ? QUOTE_COMPARISON_MISSING_LABEL
          : `${quote.deposit.percentageBasisPoints / 100} %`;
}
function terms(amount: number | null, description: string | null): string {
  return amount === null && description === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : [amount === null ? null : euro(amount), description]
        .filter(Boolean)
        .join(" · ");
}
function material(
  value: QuoteComparisonCard["materialResponsibility"],
): string {
  return value === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : value === "PROVIDER"
      ? "Zabezpečí remeselník"
      : value === "CUSTOMER"
        ? "Zabezpečí zákazník"
        : "Spoločne";
}
function inspection(quote: QuoteComparisonCard): string {
  return quote.conditionalOnInspection === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : quote.conditionalOnInspection
      ? `Podmienené obhliadkou${quote.inspectionConditions === null ? "" : ` · ${quote.inspectionConditions}`}`
      : "Nie je podmienené obhliadkou";
}
