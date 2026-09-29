"use client";

import React, { useEffect, useState } from "react";

import {
  loadJobRequestTaxonomySuggestions,
  type JobRequestTaxonomySuggestion,
} from "./job-request-taxonomy-client";
import {
  loadJobRequestMunicipalitySuggestions,
  type JobRequestMunicipalitySuggestion,
} from "./job-request-municipality-client";

interface SuggestionLookup {
  readonly query: string;
  readonly status: "loading" | "ready";
  readonly items: readonly JobRequestTaxonomySuggestion[];
}

interface MunicipalityLookup {
  readonly query: string;
  readonly status: "loading" | "ready";
  readonly items: readonly JobRequestMunicipalitySuggestion[];
}

export function publicSearchLookupMessage(
  lookup: SuggestionLookup | null,
): string | null {
  if (lookup?.status === "loading") return "Hľadáme profesie a služby…";
  if (lookup?.status === "ready" && lookup.items.length === 0)
    return "Momentálne nemáme návrh pre tento výraz. Skúste iný názov profesie alebo služby.";
  return null;
}

export function publicSearchMunicipalityMessage(
  lookup: MunicipalityLookup | null,
): string | null {
  if (lookup?.status === "loading") return "Hľadáme obce…";
  if (lookup?.status === "ready" && lookup.items.length === 0)
    return "Obec sa nenašla. Skontrolujte názov alebo hľadajte bez lokality.";
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
  const [municipalityQuery, setMunicipalityQuery] = useState("");
  const [selectedMunicipality, setSelectedMunicipality] =
    useState<JobRequestMunicipalitySuggestion | null>(null);
  const [municipalityLookup, setMunicipalityLookup] =
    useState<MunicipalityLookup | null>(null);

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

  useEffect(() => {
    const normalized = municipalityQuery.trim();
    if (selectedMunicipality !== null || normalized.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadJobRequestMunicipalitySuggestions(
        normalized,
        fetch,
        controller.signal,
      ).then((items) => {
        if (controller.signal.aborted) return;
        setMunicipalityLookup((current) =>
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
  }, [municipalityQuery, selectedMunicipality]);

  const currentLookup =
    selected === null && lookup?.query === query.trim() ? lookup : null;
  const suggestions = currentLookup?.items ?? [];
  const lookupMessage = publicSearchLookupMessage(currentLookup);
  const professionCode = selected?.professionCodes[0];
  const currentMunicipalityLookup =
    selectedMunicipality === null &&
    municipalityLookup?.query === municipalityQuery.trim()
      ? municipalityLookup
      : null;
  const municipalitySuggestions = currentMunicipalityLookup?.items ?? [];
  const municipalityMessage = publicSearchMunicipalityMessage(
    currentMunicipalityLookup,
  );
  return (
    <form action="/remeselnici" className="public-search-form" method="get">
      <div className="public-search-form__field">
        <label htmlFor="public-search-query">Profesia alebo služba</label>
        <input
          aria-autocomplete="list"
          aria-controls="public-search-profession-options"
          aria-expanded={suggestions.length > 0}
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
          role="combobox"
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
            aria-label="Návrhy profesií a služieb"
            className="profession-suggestions"
            id="public-search-profession-options"
            role="listbox"
          >
            {suggestions.map((suggestion) => (
              <li key={`${suggestion.kind}:${suggestion.code}`} role="none">
                <button
                  aria-selected="false"
                  onClick={() => {
                    setSelected(suggestion);
                    setQuery(suggestion.label);
                    setLookup(null);
                  }}
                  role="option"
                  type="button"
                >
                  {suggestion.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="public-search-form__field">
        <label htmlFor="public-search-municipality">Obec (nepovinné)</label>
        <input
          aria-autocomplete="list"
          aria-controls="public-search-municipality-options"
          aria-expanded={municipalitySuggestions.length > 0}
          autoComplete="address-level2"
          id="public-search-municipality"
          maxLength={80}
          onChange={(event) => {
            setMunicipalityQuery(event.target.value);
            setSelectedMunicipality(null);
            const normalized = event.target.value.trim();
            setMunicipalityLookup(
              normalized.length < 2
                ? null
                : { query: normalized, status: "loading", items: [] },
            );
          }}
          placeholder="Napríklad Trnava"
          role="combobox"
          value={municipalityQuery}
        />
        <p className="field-help">
          Stačí obec. Presnú adresu nezverejňujeme ani na vyhľadávanie
          nepotrebujeme.
        </p>
        {municipalityMessage === null ? null : (
          <p aria-live="polite" className="field-help" role="status">
            {municipalityMessage}
          </p>
        )}
        {municipalitySuggestions.length === 0 ? null : (
          <ul
            aria-label="Návrhy obcí"
            className="profession-suggestions"
            id="public-search-municipality-options"
            role="listbox"
          >
            {municipalitySuggestions.map((suggestion) => (
              <li key={suggestion.code} role="none">
                <button
                  aria-selected="false"
                  onClick={() => {
                    setSelectedMunicipality(suggestion);
                    setMunicipalityQuery(suggestion.name);
                    setMunicipalityLookup(null);
                  }}
                  role="option"
                  type="button"
                >
                  {suggestion.name}
                  <small>
                    {suggestion.districtName}, {suggestion.regionName}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {professionCode === undefined ? null : (
        <input name="professionCode" type="hidden" value={professionCode} />
      )}
      {selected?.kind === "SPECIALIZATION" ? (
        <input name="specializationCode" type="hidden" value={selected.code} />
      ) : null}
      {selected?.kind === "SKILL" ? (
        <input name="skillCodes" type="hidden" value={selected.code} />
      ) : null}
      {selectedMunicipality === null ? null : (
        <input
          name="municipalityCode"
          type="hidden"
          value={selectedMunicipality.code}
        />
      )}
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
