"use client";

import {
  QUOTE_COMPARISON_MISSING_LABEL,
  serializeQuoteComparison,
  type QuoteComparison,
  type QuoteComparisonCard,
  type QuoteComparisonSort,
} from "@portal/domain";
import Link from "next/link";
import React from "react";
import { useEffect, useState } from "react";

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
    const response = await input.fetch(
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
  if (result === null) return <p role="status">Načítavam ponuky…</p>;
  if (result.status !== "OK")
    return <p role="alert">Porovnanie ponúk momentálne nie je dostupné.</p>;
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
  return (
    <section aria-labelledby="quote-comparison-title">
      <header>
        <h1 id="quote-comparison-title">Porovnanie ponúk</h1>
        <p>
          Ponuky porovnávame neutrálne. Nevyberáme víťaza a dostupnosť termínu
          nie je rezervácia ani záruka.
        </p>
        <label>
          Zoradenie{" "}
          <select
            value={comparison.sort}
            onChange={(event) =>
              onSort?.(event.target.value as QuoteComparisonSort)
            }
          >
            <option value="RECEIVED">Podľa prijatia</option>
            <option value="LOWEST_COMPARABLE_PRICE">
              Najnižšia porovnateľná pevná cena
            </option>
          </select>
        </label>
      </header>
      {comparison.items.length > 3 ? (
        <fieldset>
          <legend>Vyberte najviac 3 ponuky na porovnanie</legend>
          {comparison.items.map((item) => {
            const checked = selected.includes(item.quoteId);
            return (
              <label
                key={item.quoteId}
                style={{ display: "inline-block", marginRight: "1rem" }}
              >
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
        <p>Zatiaľ nebola prijatá žiadna aktívna ponuka.</p>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "1rem",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
            marginTop: "1rem",
          }}
        >
          {visible.map((item) => (
            <QuoteCard key={item.quoteId} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function QuoteCard({ item }: { readonly item: QuoteComparisonCard }) {
  return (
    <article
      style={{
        border: "1px solid #d7d7d7",
        borderRadius: "0.75rem",
        padding: "1rem",
      }}
    >
      <h2>{item.provider.displayName}</h2>
      <p>
        {item.provider.identityVerified
          ? "Overená identita"
          : "Identita neoverená"}{" "}
        · Schválené oprávnenia: {item.provider.approvedCredentialCount}
      </p>
      <dl>
        <Fact label="Cena" value={price(item)} />
        <Fact label="Režim ceny" value={priceMode(item.price.mode)} />
        <Fact label="DPH" value={vat(item.price.vatStatus)} />
        <Fact
          label="Začiatok"
          value={item.estimatedStartOn ?? QUOTE_COMPARISON_MISSING_LABEL}
        />
        <Fact
          label="Trvanie"
          value={
            item.estimatedDurationDays === null
              ? QUOTE_COMPARISON_MISSING_LABEL
              : `${item.estimatedDurationDays} dní`
          }
        />
        <Fact
          label="Platnosť"
          value={
            item.validUntil === null
              ? QUOTE_COMPARISON_MISSING_LABEL
              : new Date(item.validUntil).toLocaleDateString("sk-SK")
          }
        />
        <Fact label="Materiál" value={material(item.materialResponsibility)} />
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
      <h3>Zahrnutý rozsah</h3>
      <Scope items={item.includedScope} />
      <h3>Nezahrnutý rozsah</h3>
      <Scope items={item.excludedScope} />
      <details>
        <summary>Podrobnosti ponuky</summary>
        {item.details === null ? (
          <p>Podrobnosti sú v potvrdenom PDF.</p>
        ) : (
          <>
            <h3>{item.details.title}</h3>
            <p>{item.details.summary}</p>
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
              label="Poznámka poskytovateľa"
              value={
                item.details.providerNotes ?? QUOTE_COMPARISON_MISSING_LABEL
              }
            />
          </>
        )}
      </details>
      {item.pdfDownloadPath === null ? null : (
        <p>
          <a href={item.pdfDownloadPath}>Otvoriť potvrdené PDF</a>
        </p>
      )}
      <p>
        <Link href={item.conversationPath}>Otvoriť konverzáciu</Link>
      </p>
    </article>
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
