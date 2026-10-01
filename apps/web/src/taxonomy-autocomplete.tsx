"use client";

import React, {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  loadJobRequestTaxonomySuggestionLookup,
  type JobRequestTaxonomySuggestion,
} from "./job-request-taxonomy-client";

export type TaxonomyLookupState =
  | Readonly<{ status: "IDLE" }>
  | Readonly<{ status: "LOADING"; query: string }>
  | Readonly<{
      status: "READY";
      query: string;
      items: readonly JobRequestTaxonomySuggestion[];
    }>
  | Readonly<{ status: "ERROR"; query: string }>;

export interface TaxonomyAutocompleteProps {
  readonly describedBy?: string;
  readonly emptyAction?: ReactNode;
  readonly helperText?: string;
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly onSelect: (suggestion: JobRequestTaxonomySuggestion) => void;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly scope?: "CAPABILITY" | "DISCOVERY";
  readonly selectedCode: string;
  readonly value: string;
}

export function taxonomyAutocompleteMessage(
  state: TaxonomyLookupState,
): string | null {
  if (state.status === "LOADING") return "Hľadám profesie a služby…";
  if (state.status === "ERROR")
    return "Návrhy profesií a služieb sa momentálne nedajú načítať. Skúste to znova.";
  if (state.status === "READY" && state.items.length === 0)
    return "Profesia ani služba sa nenašla.";
  return null;
}

export function nextTaxonomyActiveIndex(
  key: "ArrowDown" | "ArrowUp",
  current: number,
  itemCount: number,
): number {
  if (itemCount < 1) return -1;
  if (key === "ArrowDown") return current < itemCount - 1 ? current + 1 : 0;
  return current > 0 ? current - 1 : itemCount - 1;
}

export function shouldApplyTaxonomyLookup(
  requestId: number,
  latestRequestId: number,
  aborted: boolean,
): boolean {
  return !aborted && requestId === latestRequestId;
}

export function shouldShowTaxonomyEmptyAction(
  state: TaxonomyLookupState,
): boolean {
  return state.status === "READY" && state.items.length === 0;
}

export function taxonomyAutocompleteKeyAction(
  key: string,
  activeIndex: number,
  itemCount: number,
):
  | Readonly<{ kind: "MOVE"; index: number }>
  | Readonly<{ kind: "SELECT"; index: number }>
  | Readonly<{ kind: "CLOSE" }>
  | Readonly<{ kind: "NONE" }> {
  if (key === "ArrowDown" || key === "ArrowUp")
    return itemCount < 1
      ? { kind: "NONE" }
      : {
          kind: "MOVE",
          index: nextTaxonomyActiveIndex(key, activeIndex, itemCount),
        };
  if (key === "Enter" && activeIndex >= 0 && activeIndex < itemCount)
    return { kind: "SELECT", index: activeIndex };
  if (key === "Escape") return { kind: "CLOSE" };
  return { kind: "NONE" };
}

export function TaxonomyAutocomplete({
  describedBy,
  emptyAction,
  helperText = "Začnite písať a vyberte návrh zo zoznamu.",
  id,
  label,
  onChange,
  onSelect,
  placeholder = "Napríklad obkladač alebo oprava strechy",
  required = false,
  scope = "DISCOVERY",
  selectedCode,
  value,
}: TaxonomyAutocompleteProps) {
  const listboxId = `${id}-options`;
  const helperId = `${id}-help`;
  const statusId = `${id}-status`;
  const latestRequest = useRef(0);
  const [lookup, setLookup] = useState<TaxonomyLookupState>({ status: "IDLE" });
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const query = value.trim();
    if (selectedCode !== "" || query.length < 2 || query.length > 120) {
      latestRequest.current += 1;
      setLookup({ status: "IDLE" });
      setActiveIndex(-1);
      return;
    }
    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;
    const controller = new AbortController();
    setLookup({ status: "LOADING", query });
    setActiveIndex(-1);
    const timer = window.setTimeout(() => {
      void loadJobRequestTaxonomySuggestionLookup(
        query,
        fetch,
        controller.signal,
        scope,
      ).then((result) => {
        if (
          !shouldApplyTaxonomyLookup(
            requestId,
            latestRequest.current,
            controller.signal.aborted,
          )
        )
          return;
        setLookup(
          result.status === "OK"
            ? {
                status: "READY",
                query,
                items: result.suggestions
                  .filter(
                    (item) =>
                      item.kind === "PROFESSION" || item.kind === "SERVICE",
                  )
                  .slice(0, 10),
              }
            : { status: "ERROR", query },
        );
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [scope, selectedCode, value]);

  const items = lookup.status === "READY" ? lookup.items : [];
  const message = taxonomyAutocompleteMessage(lookup);
  const choose = (suggestion: JobRequestTaxonomySuggestion) => {
    latestRequest.current += 1;
    setLookup({ status: "IDLE" });
    setActiveIndex(-1);
    onSelect(suggestion);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = taxonomyAutocompleteKeyAction(
      event.key,
      activeIndex,
      items.length,
    );
    if (action.kind === "MOVE") {
      event.preventDefault();
      setActiveIndex(action.index);
      return;
    }
    if (action.kind === "SELECT") {
      const suggestion = items[action.index];
      if (suggestion !== undefined) {
        event.preventDefault();
        choose(suggestion);
        return;
      }
    }
    if (action.kind === "CLOSE") {
      latestRequest.current += 1;
      setLookup({ status: "IDLE" });
      setActiveIndex(-1);
    }
  };
  const describedByIds = [
    helperId,
    message === null ? undefined : statusId,
    describedBy,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="taxonomy-autocomplete">
      <label htmlFor={id}>{label}</label>
      <input
        aria-activedescendant={
          activeIndex < 0 ? undefined : `${listboxId}-${activeIndex}`
        }
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-describedby={describedByIds}
        aria-expanded={items.length > 0}
        autoComplete="off"
        id={id}
        maxLength={120}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        required={required}
        role="combobox"
        value={value}
      />
      <p className="field-help" id={helperId}>
        {helperText}
      </p>
      {message === null ? null : (
        <p
          aria-live="polite"
          className={`field-help taxonomy-autocomplete__status${
            lookup.status === "ERROR"
              ? " taxonomy-autocomplete__status--error"
              : ""
          }`}
          id={statusId}
          role="status"
        >
          {message}
        </p>
      )}
      {shouldShowTaxonomyEmptyAction(lookup) ? emptyAction : null}
      {items.length === 0 ? null : (
        <>
          <ul
            aria-label="Návrhy profesií a služieb"
            className="profession-suggestions taxonomy-autocomplete__options"
            id={listboxId}
            role="listbox"
          >
            {items.map((suggestion, index) => (
              <li key={`${suggestion.kind}:${suggestion.code}`} role="none">
                <button
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? "is-active" : undefined}
                  id={`${listboxId}-${index}`}
                  onClick={() => choose(suggestion)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <span className="taxonomy-autocomplete__option-main">
                    <strong>{suggestion.label}</strong>
                    <span className="taxonomy-autocomplete__badge">
                      {suggestion.kind === "SERVICE" ? "Služba" : "Profesia"}
                    </span>
                  </span>
                  <small>{craftsmanCountLabel(suggestion.memberCount)}</small>
                </button>
              </li>
            ))}
            <li className="taxonomy-autocomplete__legend" role="none">
              Počet uvádza verejne dostupných remeselníkov pre daný návrh.
            </li>
          </ul>
        </>
      )}
    </div>
  );
}

export function craftsmanCountLabel(count: number): string {
  if (count === 1) return "1 dostupný remeselník";
  if (count >= 2 && count <= 4) return `${count} dostupní remeselníci`;
  return `${count} dostupných remeselníkov`;
}
