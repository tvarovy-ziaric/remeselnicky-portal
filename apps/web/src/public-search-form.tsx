"use client";

import React, { useState } from "react";

import { type JobRequestTaxonomySuggestion } from "./job-request-taxonomy-client";
import { type JobRequestMunicipalitySuggestion } from "./job-request-municipality-client";
import {
  MunicipalityAutocomplete,
  municipalityAutocompleteMessage,
} from "./municipality-autocomplete";
import { TaxonomyAutocomplete } from "./taxonomy-autocomplete";
import type { PublicSearchFormDefaults } from "./public-search-context";

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
  initialValues,
  jobRequestId,
  jobId,
}: {
  readonly initialValues?: PublicSearchFormDefaults;
  readonly jobRequestId?: string;
  readonly jobId?: string;
}) {
  const initialTaxonomy = initialTaxonomySelection(initialValues);
  const [query, setQuery] = useState(initialValues?.professionLabel ?? "");
  const [selected, setSelected] = useState<JobRequestTaxonomySuggestion | null>(
    initialTaxonomy,
  );
  const [municipalityQuery, setMunicipalityQuery] = useState(
    initialValues?.municipalityLabel ?? "",
  );
  const [selectedMunicipalityCode, setSelectedMunicipalityCode] = useState(
    initialValues?.municipalityCode ?? "",
  );
  const [sort, setSort] = useState(initialValues?.sort ?? "RECOMMENDED");
  const [includeOutsideDeclaredArea, setIncludeOutsideDeclaredArea] = useState(
    initialValues?.includeOutsideDeclaredArea ?? false,
  );

  const professionCode =
    selected?.routingProfessionCode ?? selected?.professionCodes[0];
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
            setSelectedMunicipalityCode("");
            setIncludeOutsideDeclaredArea(false);
            if (sort === "NEAREST") setSort("RECOMMENDED");
          }}
          onSelect={(suggestion) => {
            setSelectedMunicipalityCode(suggestion.code);
            setMunicipalityQuery(suggestion.name);
          }}
          selectedCode={selectedMunicipalityCode}
          selectedLabel={municipalityQuery}
          value={municipalityQuery}
        />
      </div>
      {professionCode === undefined ? null : (
        <input name="professionCode" type="hidden" value={professionCode} />
      )}
      {selected?.kind === "SERVICE" ? (
        <input name="serviceCode" type="hidden" value={selected.code} />
      ) : null}
      {selected === null ? null : (
        <input name="professionLabel" type="hidden" value={selected.label} />
      )}
      {selected?.kind === "SPECIALIZATION" ? (
        <input name="specializationCode" type="hidden" value={selected.code} />
      ) : null}
      {selected?.kind === "SKILL" ? (
        <input name="skillCodes" type="hidden" value={selected.code} />
      ) : null}
      {selectedMunicipalityCode === "" ? null : (
        <input
          name="municipalityCode"
          type="hidden"
          value={selectedMunicipalityCode}
        />
      )}
      {selectedMunicipalityCode === "" ? null : (
        <input
          name="municipalityLabel"
          type="hidden"
          value={municipalityQuery}
        />
      )}
      <div className="public-search-form__field">
        <label htmlFor="public-search-sort">Zoradiť výsledky</label>
        <select
          id="public-search-sort"
          name="sort"
          onChange={(event) =>
            setSort(
              event.target.value as "BEST_RATED" | "NEAREST" | "RECOMMENDED",
            )
          }
          value={sort}
        >
          <option value="RECOMMENDED">Odporúčané</option>
          <option disabled={selectedMunicipalityCode === ""} value="NEAREST">
            Najbližší
          </option>
          <option value="BEST_RATED">Najlepšie hodnotení</option>
        </select>
      </div>
      <div className="public-search-form__field">
        <label>
          <input
            checked={includeOutsideDeclaredArea}
            disabled={selectedMunicipalityCode === ""}
            name="includeOutsideDeclaredArea"
            onChange={(event) =>
              setIncludeOutsideDeclaredArea(event.target.checked)
            }
            type="checkbox"
            value="true"
          />{" "}
          Zobraziť aj remeselníkov mimo ich bežného dosahu
        </label>
        <p className="field-help">
          Výsledky automaticky rešpektujú dojazd nastavený remeselníkmi.
          Vzdialenosť počítame orientačne od zvolenej obce.
        </p>
      </div>
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

function initialTaxonomySelection(
  values: PublicSearchFormDefaults | undefined,
): JobRequestTaxonomySuggestion | null {
  if (
    values?.professionCode === null ||
    values?.professionCode === undefined ||
    values.professionLabel === ""
  ) {
    return null;
  }
  return Object.freeze({
    code: values.serviceCode ?? values.professionCode,
    kind:
      values.serviceCode === null
        ? ("PROFESSION" as const)
        : ("SERVICE" as const),
    label: values.professionLabel,
    memberCount: 0,
    professionCodes: Object.freeze([values.professionCode]),
    routingProfessionCode: values.professionCode,
  });
}
