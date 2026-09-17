"use client";

import React, { useEffect, useState } from "react";

import {
  loadJobRequestTaxonomySuggestions,
  type JobRequestTaxonomySuggestion,
} from "./job-request-taxonomy-client";

interface SuggestionLookup {
  readonly query: string;
  readonly status: "loading" | "ready";
  readonly items: readonly JobRequestTaxonomySuggestion[];
}

export function publicSearchLookupMessage(
  lookup: SuggestionLookup | null,
): string | null {
  if (lookup?.status === "loading") return "Hľadáme profesie a služby…";
  if (lookup?.status === "ready" && lookup.items.length === 0)
    return "Momentálne nemáme návrh pre tento výraz. Skúste iný názov profesie alebo služby.";
  return null;
}

export function PublicSearchForm({
  jobRequestId,
  jobId,
}: {
  readonly jobRequestId?: string;
  readonly jobId?: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<JobRequestTaxonomySuggestion | null>(
    null,
  );
  const [lookup, setLookup] = useState<SuggestionLookup | null>(null);

  useEffect(() => {
    const normalized = query.trim();
    if (selected !== null || normalized.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadJobRequestTaxonomySuggestions(
        normalized,
        fetch,
        controller.signal,
      ).then((items) => {
        if (controller.signal.aborted) return;
        setLookup((current) =>
          current?.query === normalized && current.status === "loading"
            ? { query: normalized, status: "ready", items }
            : current,
        );
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, selected]);

  const currentLookup =
    selected === null && lookup?.query === query.trim() ? lookup : null;
  const suggestions = currentLookup?.items ?? [];
  const lookupMessage = publicSearchLookupMessage(currentLookup);
  const professionCode = selected?.professionCodes[0];
  return (
    <form action="/remeselnici" className="public-search-form" method="get">
      <label htmlFor="public-search-query">Profesia alebo služba</label>
      <input
        autoComplete="off"
        id="public-search-query"
        maxLength={120}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(null);
          const normalized = event.target.value.trim();
          setLookup(
            normalized.length < 2
              ? null
              : { query: normalized, status: "loading", items: [] },
          );
        }}
        placeholder="Napríklad obkladač alebo oprava strechy"
        required
        value={query}
      />
      <p className="field-help">Začnite písať a vyberte návrh zo zoznamu.</p>
      {lookupMessage === null ? null : (
        <p aria-live="polite" className="field-help" role="status">
          {lookupMessage}
        </p>
      )}
      {suggestions.length === 0 ? null : (
        <ul
          className="profession-suggestions"
          aria-label="Návrhy profesií a služieb"
        >
          {suggestions.map((suggestion) => (
            <li key={`${suggestion.kind}:${suggestion.code}`}>
              <button
                onClick={() => {
                  setSelected(suggestion);
                  setQuery(suggestion.label);
                  setLookup(null);
                }}
                type="button"
              >
                {suggestion.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {professionCode === undefined ? null : (
        <input name="professionCode" type="hidden" value={professionCode} />
      )}
      {selected?.kind === "SPECIALIZATION" ? (
        <input name="specializationCode" type="hidden" value={selected.code} />
      ) : null}
      {selected?.kind === "SKILL" ? (
        <input name="skillCodes" type="hidden" value={selected.code} />
      ) : null}
      {jobRequestId === undefined || jobId !== undefined ? null : (
        <input name="jobRequestId" type="hidden" value={jobRequestId} />
      )}
      {jobId === undefined || jobRequestId !== undefined ? null : (
        <input name="jobId" type="hidden" value={jobId} />
      )}
      <button disabled={professionCode === undefined} type="submit">
        Hľadať remeselníkov
      </button>
    </form>
  );
}
