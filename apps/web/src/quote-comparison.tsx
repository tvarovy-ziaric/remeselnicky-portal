"use client";

import {
  QUOTE_COMPARISON_MISSING_LABEL,
  serializeQuoteComparison,
  type QuoteComparison,
  type QuoteComparisonCard,
  type QuoteComparisonSort,
} from "@portal/domain";
import React from "react";
import { useEffect, useRef, useState } from "react";

import {
  ActionLink,
  Card,
  EmptyState,
  Select,
  StatusBadge,
  TrustBadge,
} from "./design-system";

const R3_ANALYTICS_OBSERVATION_PATH = "/v1/me/analytics/r3-observations";

export async function recordQuoteComparisonObservation(input: {
  readonly fetch: typeof fetch;
  readonly jobRequestId: string;
  readonly invitationId?: string;
  readonly kind:
    | "INVITATION_VIEWED"
    | "QUOTE_VIEWED"
    | "QUOTE_COMPARISON_OPENED"
    | "QUOTE_COMPARISON_PDF_OPENED";
  readonly quoteId?: string;
  readonly quoteRevision?: number;
}): Promise<void> {
  try {
    const session = await input.fetch.call(globalThis, "/v1/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!session.ok) return;
    const body = (await session.json()) as Record<string, unknown>;
    if (typeof body["csrfToken"] !== "string") return;
    await input.fetch.call(globalThis, R3_ANALYTICS_OBSERVATION_PATH, {
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        jobRequestId: input.jobRequestId,
        ...(input.invitationId === undefined
          ? {}
          : { invitationId: input.invitationId }),
        kind: input.kind,
        ...(input.quoteId === undefined ? {} : { quoteId: input.quoteId }),
        ...(input.quoteRevision === undefined
          ? {}
          : { quoteRevision: input.quoteRevision }),
      }),
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": body["csrfToken"],
      },
      keepalive: true,
      method: "POST",
    });
  } catch {
    // Analytics is intentionally isolated from the commercial workflow.
  }
}

export function observeActualVisibility(
  element: Element,
  onVisible: () => void,
): () => void {
  if (
    typeof IntersectionObserver === "undefined" ||
    typeof document === "undefined"
  ) {
    return () => undefined;
  }
  let intersecting = false;
  let completed = false;
  const emit = () => {
    if (!completed && intersecting && document.visibilityState === "visible") {
      completed = true;
      onVisible();
      observer.disconnect();
      document.removeEventListener("visibilitychange", emit);
    }
  };
  const observer = new IntersectionObserver((entries) => {
    intersecting = entries.some(
      (entry) => entry.target === element && entry.isIntersecting,
    );
    emit();
  });
  observer.observe(element);
  document.addEventListener("visibilitychange", emit);
  return () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", emit);
  };
}

export async function loadQuoteComparison(input: {
  readonly fetch: typeof fetch;
  readonly jobRequestId: string;
  readonly sort?: QuoteComparisonSort;
}): Promise<
  | { readonly comparison: QuoteComparison; readonly status: "OK" }
  | { readonly status: "NOT_FOUND" | "UNAVAILABLE" }
> {
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        input.jobRequestId,
      )
    )
      return { status: "UNAVAILABLE" };
    const suffix =
      input.sort === undefined ? "" : `?sort=${encodeURIComponent(input.sort)}`;
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-requests/${input.jobRequestId}/quote-comparison${suffix}`,
      {
        cache: "no-store",
        credentials: "same-origin",
      },
    );
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    return {
      comparison: serializeQuoteComparison(await response.json()),
      status: "OK",
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function QuoteComparisonEntry({
  jobRequestId,
}: {
  readonly jobRequestId: string;
}) {
  const [sort, setSort] = useState<QuoteComparisonSort>("RECEIVED");
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof loadQuoteComparison>
  > | null>(null);
  useEffect(() => {
    let active = true;
    void loadQuoteComparison({ fetch, jobRequestId, sort }).then((next) => {
      if (active) setResult(next);
    });
    return () => {
      active = false;
    };
  }, [jobRequestId, sort]);
  if (result === null)
    return (
      <p role="status">
        <StatusBadge>Načítavam ponuky…</StatusBadge>
      </p>
    );
  if (result.status !== "OK")
    return (
      <div role="alert">
        <StatusBadge tone="error">Porovnanie nie je dostupné</StatusBadge>
        <p>Porovnanie ponúk sa momentálne nepodarilo načítať.</p>
      </div>
    );
  return (
    <QuoteComparisonView comparison={result.comparison} onSort={setSort} />
  );
}

export function QuoteComparisonView({
  comparison,
  onSort,
}: {
  readonly comparison: QuoteComparison;
  readonly onSort?: (sort: QuoteComparisonSort) => void;
}) {
  const [selected, setSelected] = useState(() =>
    comparison.items.slice(0, 3).map((item) => item.quoteId),
  );
  const comparisonElement = useRef<HTMLElement>(null);
  useEffect(() => {
    setSelected((current) =>
      comparison.items.length <= 3
        ? comparison.items.map((item) => item.quoteId)
        : current
            .filter((id) =>
              comparison.items.some((item) => item.quoteId === id),
            )
            .slice(0, 3),
    );
  }, [comparison.items]);
  const visible = comparison.items.filter((item) =>
    selected.includes(item.quoteId),
  );
  useEffect(() => {
    if (comparisonElement.current === null) return;
    return observeActualVisibility(comparisonElement.current, () => {
      void recordQuoteComparisonObservation({
        fetch,
        jobRequestId: comparison.jobRequestId,
        kind: "QUOTE_COMPARISON_OPENED",
      });
    });
  }, [comparison.jobRequestId]);
  return (
    <section
      aria-labelledby="quote-comparison-title"
      className="quote-comparison"
      ref={comparisonElement}
    >
      <header className="quote-comparison__intro">
        <h2 id="quote-comparison-title">Ponuky vedľa seba</h2>
        <p>
          Ponuky porovnávame neutrálne. Nevyberáme víťaza a dostupnosť termínu
          nie je rezervácia ani záruka.
        </p>
        <label className="quote-comparison__sort">
          <span>Zoradenie</span>
          <Select
            value={comparison.sort}
            onChange={(event) =>
              onSort?.(event.target.value as QuoteComparisonSort)
            }
          >
            <option value="RECEIVED">Podľa prijatia</option>
            <option value="LOWEST_COMPARABLE_PRICE">
              Najnižšia porovnateľná pevná cena
            </option>
          </Select>
        </label>
      </header>
      {comparison.items.length > 3 ? (
        <fieldset className="quote-comparison__selection">
          <legend>Vyberte najviac 3 ponuky na porovnanie</legend>
          {comparison.items.map((item) => {
            const checked = selected.includes(item.quoteId);
            return (
              <label key={item.quoteId}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && selected.length >= 3}
                  onChange={() =>
                    setSelected((current) =>
                      checked
                        ? current.filter((id) => id !== item.quoteId)
                        : [...current, item.quoteId],
                    )
                  }
                />{" "}
                {item.provider.displayName}
              </label>
            );
          })}
        </fieldset>
      ) : null}
      {comparison.items.length === 0 ? (
        <EmptyState
          description="Keď remeselník odošle aktívnu ponuku, zobrazí sa tu v rovnakom porovnávacom formáte."
          title="Zatiaľ bez aktívnych ponúk"
        />
      ) : (
        <div className="quote-comparison__grid">
          {visible.map((item) => (
            <QuoteCard
              jobRequestId={comparison.jobRequestId}
              key={item.quoteId}
              item={item}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function QuoteCard({
  item,
  jobRequestId,
}: {
  readonly item: QuoteComparisonCard;
  readonly jobRequestId: string;
}) {
  const cardElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cardElement.current === null) return;
    return observeActualVisibility(cardElement.current, () => {
      void recordQuoteComparisonObservation({
        fetch,
        jobRequestId,
        kind: "QUOTE_VIEWED",
        quoteId: item.quoteId,
        quoteRevision: item.quoteRevision,
      });
    });
  }, [item.quoteId, item.quoteRevision, jobRequestId]);
  const acceptancePath = `/ziadosti/${jobRequestId}/ponuky/${item.quoteId}/potvrdenie`;
  return (
    <div className="quote-comparison-card-observer" ref={cardElement}>
      <Card className="quote-comparison-card">
        <header className="quote-comparison-card__header">
          <div>
            <p className="ui-eyebrow">Ponuka od remeselníka</p>
            <h3>{item.provider.displayName}</h3>
            <p>
              Revízia ponuky {item.quoteRevision} · prijatá{" "}
              {formatDateTime(item.submittedAt)}
            </p>
            <p>{authoringMode(item.authoringMode)}</p>
          </div>
          <StatusBadge
            tone={
              item.materiallyStale
                ? "warning"
                : item.lifecycleAcceptanceEligible
                  ? "success"
                  : "default"
            }
          >
            {item.materiallyStale
              ? "Čaká na aktualizáciu"
              : item.lifecycleAcceptanceEligible
                ? "Pripravená na výber"
                : "Momentálne nemožno vybrať"}
          </StatusBadge>
        </header>

        <div className="quote-comparison-card__trust">
          {item.provider.identityVerified ? (
            <TrustBadge provenance="verified">Totožnosť</TrustBadge>
          ) : (
            <StatusBadge>Totožnosť zatiaľ neoverená</StatusBadge>
          )}
          {item.provider.approvedCredentialCount > 0 ? (
            <TrustBadge provenance="verified">
              Schválené oprávnenia: {item.provider.approvedCredentialCount}
            </TrustBadge>
          ) : (
            <StatusBadge>Schválené oprávnenia: 0</StatusBadge>
          )}
        </div>

        {item.materiallyStale ? (
          <p className="quote-comparison-card__warning" role="alert">
            Požiadavka sa podstatne zmenila. Pred ďalším krokom musí remeselník
            ponuku potvrdiť alebo poslať novú revíziu.
          </p>
        ) : null}

        <dl className="quote-comparison-card__facts">
          <Fact label="Cena" value={price(item)} />
          <Fact label="Typ ceny" value={priceMode(item.price.mode)} />
          <Fact label="DPH" value={vat(item.price.vatStatus)} />
          <Fact
            label="Predpokladaný začiatok"
            value={
              item.estimatedStartOn === null
                ? QUOTE_COMPARISON_MISSING_LABEL
                : formatDate(item.estimatedStartOn)
            }
          />
          <Fact
            label="Odhadované trvanie"
            value={
              item.estimatedDurationDays === null
                ? QUOTE_COMPARISON_MISSING_LABEL
                : formatDurationDays(item.estimatedDurationDays)
            }
          />
          <Fact
            label="Ponuka platí do"
            value={
              item.validUntil === null
                ? QUOTE_COMPARISON_MISSING_LABEL
                : formatDate(item.validUntil)
            }
          />
        </dl>

        <div className="quote-comparison-card__scope">
          <div aria-label="Zahrnutý rozsah">
            <h4>Zahrnuté v ponuke</h4>
            <Scope items={item.includedScope} />
          </div>
          <div aria-label="Nezahrnutý rozsah">
            <h4>Nie je zahrnuté</h4>
            <Scope items={item.excludedScope} />
          </div>
        </div>

        <details className="quote-comparison-card__details">
          <summary>Všetky podmienky ponuky</summary>
          <dl>
            <Fact
              label="Materiál"
              value={material(item.materialResponsibility)}
            />
            <Fact
              label="Doprava"
              value={component(item.travelAmountCents, item.travelDescription)}
            />
            <Fact label="Záloha" value={deposit(item)} />
            <Fact
              label="Záruka"
              value={item.warrantyInformation ?? QUOTE_COMPARISON_MISSING_LABEL}
            />
            <Fact label="Obhliadka" value={inspection(item)} />
          </dl>
          {item.details === null ? (
            <p>Podrobnosti tejto ponuky sú v potvrdenom PDF.</p>
          ) : (
            <div aria-label="Rozpis ponuky">
              <h4>{item.details.title}</h4>
              <p>{item.details.summary}</p>
              <dl>
                <Fact label="Cenový základ" value={item.details.priceBasis} />
                <Fact
                  label="Práca"
                  value={component(
                    item.details.components.labor.amountCents,
                    item.details.components.labor.description,
                  )}
                />
                <Fact
                  label="Materiál"
                  value={component(
                    item.details.components.material.amountCents,
                    item.details.components.material.description,
                  )}
                />
                <Fact
                  label="Ostatné"
                  value={component(
                    item.details.components.other.amountCents,
                    item.details.components.other.description,
                  )}
                />
                <Fact
                  label="Poznámka k zálohe"
                  value={
                    item.details.depositNotes ?? QUOTE_COMPARISON_MISSING_LABEL
                  }
                />
                <Fact
                  label="Poznámka remeselníka"
                  value={
                    item.details.providerNotes ?? QUOTE_COMPARISON_MISSING_LABEL
                  }
                />
              </dl>
            </div>
          )}
        </details>

        <p className="quote-comparison-card__snapshot-note">
          Pri potvrdení sa uloží presne táto revízia ponuky.
        </p>
        <div className="quote-comparison-card__actions">
          {item.pdfDownloadPath === null ? null : (
            <ActionLink href={item.pdfDownloadPath} variant="quiet">
              Otvoriť potvrdené PDF
            </ActionLink>
          )}
          <ActionLink href={item.conversationPath} variant="quiet">
            Otvoriť konverzáciu
          </ActionLink>
          {item.lifecycleAcceptanceEligible ? (
            <ActionLink href={acceptancePath}>Vybrať túto ponuku</ActionLink>
          ) : null}
        </div>
      </Card>
    </div>
  );
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
function euro(cents: number) {
  return new Intl.NumberFormat("sk-SK", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}
function price(item: QuoteComparisonCard) {
  return item.price.mode === "RANGE"
    ? `${euro(item.price.rangeMinimumCents as number)} – ${euro(item.price.rangeMaximumCents as number)} (rozsah, nie konečná cena)`
    : euro(item.price.totalAmountCents as number);
}
function priceMode(mode: QuoteComparisonCard["price"]["mode"]) {
  return mode === "FIXED"
    ? "Pevná cena"
    : mode === "ESTIMATE"
      ? "Odhad"
      : "Cenový rozsah";
}
function vat(status: QuoteComparisonCard["price"]["vatStatus"]) {
  return status === "VAT_INCLUDED"
    ? "DPH zahrnutá"
    : status === "VAT_EXCLUDED"
      ? "Bez DPH"
      : "Neplatca DPH";
}
function material(value: QuoteComparisonCard["materialResponsibility"]) {
  return value === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : value === "PROVIDER"
      ? "Zabezpečí remeselník"
      : value === "CUSTOMER"
        ? "Zabezpečí zákazník"
        : "Spoločne";
}
function component(amount: number | null, description: string | null) {
  return amount === null && description === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : [amount === null ? null : euro(amount), description]
        .filter(Boolean)
        .join(" · ");
}
function deposit(item: QuoteComparisonCard) {
  return item.deposit.mode === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : item.deposit.mode === "NONE"
      ? "Bez zálohy"
      : item.deposit.mode === "FIXED_AMOUNT"
        ? euro(item.deposit.amountCents as number)
        : `${(item.deposit.percentageBasisPoints as number) / 100} %`;
}
function inspection(item: QuoteComparisonCard) {
  return item.conditionalOnInspection === null
    ? QUOTE_COMPARISON_MISSING_LABEL
    : item.conditionalOnInspection
      ? `Podmienené obhliadkou${item.inspectionConditions === null ? "" : ` · ${item.inspectionConditions}`}`
      : "Nie je podmienené obhliadkou";
}

function authoringMode(mode: QuoteComparisonCard["authoringMode"]): string {
  return mode === "PLATFORM_STRUCTURED"
    ? "Ponuka vyplnená v portáli"
    : "Ponuka dodaná ako potvrdené PDF";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

function formatDurationDays(value: number): string {
  if (value === 1) return "1 deň";
  if (value >= 2 && value <= 4) return `${value} dni`;
  return `${value} dní`;
}
