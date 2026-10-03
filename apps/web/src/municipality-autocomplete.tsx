"use client";

import React, { type KeyboardEvent, useEffect, useRef, useState } from "react";

import {
  formatPostalCode,
  isMunicipalityQueryEligible,
  loadJobRequestMunicipalitySuggestions,
  type JobRequestMunicipalitySuggestion,
} from "./job-request-municipality-client";

type LookupState =
  | { readonly status: "LOADING"; readonly suggestions: readonly [] }
  | {
      readonly status: "READY";
      readonly suggestions: readonly JobRequestMunicipalitySuggestion[];
    }
  | { readonly status: "ZERO"; readonly suggestions: readonly [] }
  | { readonly status: "ERROR"; readonly suggestions: readonly [] };

export interface MunicipalityAutocompleteProps {
  readonly id: string;
  readonly onChange: (value: string) => void;
  readonly onSelect: (
    suggestion: JobRequestMunicipalitySuggestion,
    selectedPostalCode: string | null,
  ) => void;
  readonly required?: boolean;
  readonly selectedCode: string;
  readonly selectedLabel?: string | undefined;
  readonly value: string;
}

export function municipalityAutocompleteMessage(
  status: LookupState["status"] | null,
): string | null {
  if (status === "LOADING") return "Hľadám lokality…";
  if (status === "ZERO") return "Lokalita ani PSČ sa nenašli.";
  if (status === "ERROR")
    return "Návrhy lokalít sa momentálne nedajú načítať. Skúste to znova.";
  return null;
}

export function nextMunicipalityActiveIndex(
  current: number,
  itemCount: number,
  direction: 1 | -1,
): number {
  if (itemCount <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : itemCount - 1;
  return (current + direction + itemCount) % itemCount;
}

export function municipalityKeyboardAction(
  key: string,
  activeIndex: number,
  itemCount: number,
  expanded: boolean,
):
  | { readonly type: "MOVE"; readonly index: number }
  | { readonly type: "CHOOSE" }
  | { readonly type: "CLOSE" }
  | null {
  if (key === "Escape") return { type: "CLOSE" };
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (itemCount === 0) return null;
    return {
      type: "MOVE",
      index: nextMunicipalityActiveIndex(
        activeIndex,
        itemCount,
        key === "ArrowDown" ? 1 : -1,
      ),
    };
  }
  if (key === "Enter" && expanded && activeIndex >= 0) {
    return { type: "CHOOSE" };
  }
  return null;
}

export function shouldApplyMunicipalityResponse(
  activeRequestId: number,
  responseRequestId: number,
  aborted: boolean,
): boolean {
  return !aborted && activeRequestId === responseRequestId;
}

export function municipalitySelectionAfterEdit(value: string): {
  readonly municipalityCode: "";
  readonly query: string;
  readonly selectedPostalCode: null;
} {
  return Object.freeze({
    municipalityCode: "",
    query: value,
    selectedPostalCode: null,
  });
}

export function relevantPostalCodes(
  suggestion: JobRequestMunicipalitySuggestion,
  query: string,
): readonly string[] {
  const compact = query.replaceAll(" ", "").trim();
  if (!/^\d{3,5}$/u.test(compact)) return suggestion.postalCodes;
  const matches = suggestion.postalCodes.filter((code) =>
    code.startsWith(compact),
  );
  return matches.length > 0 ? matches : suggestion.postalCodes;
}

export function formatRegionName(regionName: string): string {
  return /\bkraj$/iu.test(regionName.trim())
    ? regionName
    : `${regionName} kraj`;
}

export function municipalitySuggestionMetadata(
  suggestion: JobRequestMunicipalitySuggestion,
  query: string,
): string {
  const regionName = formatRegionName(suggestion.regionName);
  if (suggestion.kind === "CITY_AREA") {
    return `celé mesto · ${regionName}`;
  }
  const postalCodes = relevantPostalCodes(suggestion, query);
  const shownPostalCodes = postalCodes.slice(0, 3);
  const remainingCount = postalCodes.length - shownPostalCodes.length;
  return [
    shownPostalCodes.map(formatPostalCode).join(", ") +
      (remainingCount > 0 ? ` + ${remainingCount} ďalších PSČ` : ""),
    suggestion.districtName === null
      ? null
      : `okres ${suggestion.districtName}`,
    regionName,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

export function MunicipalityAutocomplete({
  id,
  onChange,
  onSelect,
  required = false,
  selectedCode,
  selectedLabel,
  value,
}: MunicipalityAutocompleteProps) {
  const [lookup, setLookup] = useState<LookupState | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [closed, setClosed] = useState(false);
  const activeRequestId = useRef(0);
  const listboxId = `${id}-options`;
  const helpId = `${id}-help`;
  const statusId = `${id}-status`;

  useEffect(() => {
    const normalized = value.trim();
    if (selectedCode !== "" || !isMunicipalityQueryEligible(normalized)) {
      activeRequestId.current += 1;
      setLookup(null);
      setActiveIndex(-1);
      return;
    }
    const requestId = activeRequestId.current + 1;
    activeRequestId.current = requestId;
    const controller = new AbortController();
    setLookup({ status: "LOADING", suggestions: [] });
    setActiveIndex(-1);
    setClosed(false);
    const timer = window.setTimeout(() => {
      void loadJobRequestMunicipalitySuggestions(
        normalized,
        fetch,
        controller.signal,
      ).then((result) => {
        if (
          !shouldApplyMunicipalityResponse(
            activeRequestId.current,
            requestId,
            controller.signal.aborted,
          )
        )
          return;
        if (result.status === "OK") {
          setLookup({ status: "READY", suggestions: result.suggestions });
          return;
        }
        setLookup({ status: result.status, suggestions: [] });
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [selectedCode, value]);

  const suggestions = lookup?.suggestions ?? [];
  const expanded = !closed && suggestions.length > 0;
  const activeOptionId =
    expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined;

  const choose = (suggestion: JobRequestMunicipalitySuggestion) => {
    const compact = value.replaceAll(" ", "").trim();
    const selectedPostalCode =
      /^\d{5}$/u.test(compact) && suggestion.postalCodes.includes(compact)
        ? compact
        : null;
    onSelect(suggestion, selectedPostalCode);
    setLookup(null);
    setActiveIndex(-1);
    setClosed(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = municipalityKeyboardAction(
      event.key,
      activeIndex,
      suggestions.length,
      expanded,
    );
    if (action?.type === "CLOSE") {
      if (expanded) event.preventDefault();
      setClosed(true);
      setActiveIndex(-1);
      return;
    }
    if (action?.type === "MOVE") {
      event.preventDefault();
      setClosed(false);
      setActiveIndex(action.index);
      return;
    }
    if (action?.type === "CHOOSE") {
      event.preventDefault();
      const suggestion = suggestions[activeIndex];
      if (suggestion !== undefined) choose(suggestion);
    }
  };

  const message = municipalityAutocompleteMessage(lookup?.status ?? null);
  return (
    <div className="location-autocomplete">
      <label htmlFor={id}>Obec alebo PSČ</label>
      <input
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-describedby={`${helpId}${message === null ? "" : ` ${statusId}`}`}
        aria-expanded={expanded}
        autoComplete="off"
        id={id}
        inputMode="search"
        maxLength={80}
        onChange={(event) => {
          const invalidated = municipalitySelectionAfterEdit(
            event.target.value,
          );
          onChange(invalidated.query);
          setLookup(null);
          setActiveIndex(-1);
          setClosed(false);
        }}
        onKeyDown={onKeyDown}
        placeholder="Začnite písať obec alebo PSČ"
        required={required}
        role="combobox"
        value={value}
      />
      <p className="field-help" id={helpId}>
        Vyhľadajte lokalitu podľa názvu obce alebo poštového smerovacieho čísla.
      </p>
      {message === null ? null : (
        <p
          aria-live="polite"
          className={`field-help location-autocomplete__status location-autocomplete__status--${lookup?.status.toLowerCase()}`}
          id={statusId}
          role="status"
        >
          {message}
        </p>
      )}
      {!expanded ? null : (
        <ul
          aria-label="Návrhy lokalít a PSČ"
          className="profession-suggestions location-autocomplete__options"
          id={listboxId}
          role="listbox"
        >
          {suggestions.map((suggestion, index) => {
            const active = index === activeIndex;
            const metadata = municipalitySuggestionMetadata(suggestion, value);
            return (
              <li key={suggestion.code} role="none">
                <button
                  aria-label={`${suggestion.name} · ${metadata}`}
                  aria-selected={active}
                  className={active ? "is-active" : undefined}
                  id={`${id}-option-${index}`}
                  onClick={() => choose(suggestion)}
                  onMouseDown={(event) => event.preventDefault()}
                  role="option"
                  type="button"
                >
                  <span className="location-autocomplete__option-name">
                    {suggestion.name}
                  </span>
                  <small>{metadata}</small>
                  {active ? (
                    <span className="visually-hidden">Aktívny návrh</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selectedCode === "" ? null : (
        <p className="selection-state">
          Vybraná lokalita: {selectedLabel || value}
        </p>
      )}
    </div>
  );
}
