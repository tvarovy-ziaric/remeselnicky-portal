import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  craftsmanCountLabel,
  nextTaxonomyActiveIndex,
  shouldApplyTaxonomyLookup,
  shouldShowTaxonomyEmptyAction,
  TaxonomyAutocomplete,
  taxonomyAutocompleteKeyAction,
  taxonomyAutocompleteMessage,
} from "./taxonomy-autocomplete";

describe("TaxonomyAutocomplete", () => {
  it("renders an accessible managed-selection combobox", () => {
    const html = renderToStaticMarkup(
      <TaxonomyAutocomplete
        id="profession-service"
        label="Profesia alebo služba"
        onChange={() => undefined}
        onSelect={() => undefined}
        required
        selectedCode=""
        value=""
      />,
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-controls="profession-service-options"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="profession-service-help"');
    expect(html).toContain("Profesia alebo služba");
  });

  it("cycles deterministic keyboard focus through bounded options", () => {
    expect(nextTaxonomyActiveIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextTaxonomyActiveIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextTaxonomyActiveIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextTaxonomyActiveIndex("ArrowUp", -1, 3)).toBe(2);
    expect(nextTaxonomyActiveIndex("ArrowDown", -1, 0)).toBe(-1);
    expect(taxonomyAutocompleteKeyAction("ArrowDown", -1, 3)).toEqual({
      kind: "MOVE",
      index: 0,
    });
    expect(taxonomyAutocompleteKeyAction("Enter", 1, 3)).toEqual({
      kind: "SELECT",
      index: 1,
    });
    expect(taxonomyAutocompleteKeyAction("Escape", 1, 3)).toEqual({
      kind: "CLOSE",
    });
  });

  it("rejects stale or aborted lookup responses", () => {
    expect(shouldApplyTaxonomyLookup(4, 4, false)).toBe(true);
    expect(shouldApplyTaxonomyLookup(3, 4, false)).toBe(false);
    expect(shouldApplyTaxonomyLookup(4, 4, true)).toBe(false);
  });

  it("uses distinct loading, zero-result, and error announcements", () => {
    expect(
      taxonomyAutocompleteMessage({ status: "LOADING", query: "mur" }),
    ).toBe("Hľadám profesie a služby…");
    expect(
      taxonomyAutocompleteMessage({ status: "READY", query: "x", items: [] }),
    ).toBe("Profesia ani služba sa nenašla.");
    expect(
      taxonomyAutocompleteMessage({ status: "ERROR", query: "mur" }),
    ).toContain("momentálne nedajú načítať");
    expect(taxonomyAutocompleteMessage({ status: "IDLE" })).toBeNull();
    expect(
      shouldShowTaxonomyEmptyAction({
        status: "READY",
        query: "neexistuje",
        items: [],
      }),
    ).toBe(true);
    expect(
      shouldShowTaxonomyEmptyAction({ status: "LOADING", query: "nov" }),
    ).toBe(false);
    expect(
      shouldShowTaxonomyEmptyAction({ status: "ERROR", query: "nov" }),
    ).toBe(false);
  });

  it("formats only the safe aggregate count", () => {
    expect(craftsmanCountLabel(0)).toBe("0 dostupných remeselníkov");
    expect(craftsmanCountLabel(1)).toBe("1 dostupný remeselník");
    expect(craftsmanCountLabel(3)).toBe("3 dostupní remeselníci");
    expect(craftsmanCountLabel(10)).toBe("10 dostupných remeselníkov");
  });
});
