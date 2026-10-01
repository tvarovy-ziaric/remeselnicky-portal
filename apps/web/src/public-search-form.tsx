"use client";

import React, { useState } from "react";

import { type JobRequestTaxonomySuggestion } from "./job-request-taxonomy-client";
import { type JobRequestMunicipalitySuggestion } from "./job-request-municipality-client";
import {
  MunicipalityAutocomplete,
  municipalityAutocompleteMessage,
} from "./municipality-autocomplete";
import { TaxonomyAutocomplete } from "./taxonomy-autocomplete";

interface SuggestionLookup {
  readonly query: string;
  readonly status: "loading" | "ready";
  readonly items: readonly JobRequestTaxonomySuggestion[];
}

interface MunicipalityLookup {
  readonly query: string;
  readonly status: "loading" | "ready" | "error";
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
  if (lookup?.status === "loading")
    return municipalityAutocompleteMessage("LOADING");
  if (lookup?.status === "error")
    return municipalityAutocompleteMessage("ERROR");
  if (lookup?.status === "ready" && lookup.items.length === 0)
    return municipalityAutocompleteMessage("ZERO");
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
  const [municipalityQuery, setMunicipalityQuery] = useState("");
  const [selectedMunicipality, setSelectedMunicipality] =
    useState<JobRequestMunicipalitySuggestion | null>(null);

  const professionCode = selected?.professionCodes[0];
  return (
    <form action="/remeselnici" className="public-search-form" method="get">
      <div className="public-search-form__field">
        <TaxonomyAutocomplete
          id="public-search-query"
          label="Profesia alebo služba"
          onChange={(value) => {
            setQuery(value);
            setSelected(null);
          }}
          onSelect={(suggestion) => {
            setSelected(suggestion);
            setQuery(suggestion.label);
          }}
          placeholder="Napríklad obkladač alebo oprava strechy"
          required
          selectedCode={selected?.code ?? ""}
          value={query}
        />
      </div>
      <div className="public-search-form__field">
        <MunicipalityAutocomplete
          id="public-search-municipality"
          onChange={(value) => {
            setMunicipalityQuery(value);
            setSelectedMunicipality(null);
          }}
          onSelect={(suggestion) => {
            setSelectedMunicipality(suggestion);
            setMunicipalityQuery(suggestion.name);
          }}
          selectedCode={selectedMunicipality?.code ?? ""}
          selectedLabel={selectedMunicipality?.name}
          value={municipalityQuery}
        />
      </div>
      {professionCode === undefined ? null : (
        <input name="professionCode" type="hidden" value={professionCode} />
      )}
      {selected?.kind === "SERVICE" ? (
        <input name="serviceCode" type="hidden" value={selected.code} />
      ) : null}
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
