import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { JobRequestMunicipalitySuggestion } from "./job-request-municipality-client";
import {
  MunicipalityAutocomplete,
  formatRegionName,
  municipalityAutocompleteMessage,
  municipalityKeyboardAction,
  municipalitySelectionAfterEdit,
  nextMunicipalityActiveIndex,
  relevantPostalCodes,
  shouldApplyMunicipalityResponse,
} from "./municipality-autocomplete";

const prievidza: JobRequestMunicipalitySuggestion = {
  code: "SK022D513881",
  districtName: "Prievidza",
  name: "Prievidza",
  postalCodes: ["97101", "97102", "97103"],
  regionName: "Trenčiansky kraj",
};

describe("MunicipalityAutocomplete", () => {
  it("renders the shared accessible Obec alebo PSČ contract", () => {
    const html = renderToStaticMarkup(
      <MunicipalityAutocomplete
        id="test-location"
        onChange={vi.fn()}
        onSelect={vi.fn()}
        selectedCode=""
        value=""
      />,
    );

    expect(html).toContain("Obec alebo PSČ");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-controls="test-location-options"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('placeholder="Začnite písať obec alebo PSČ"');
    expect(html).toContain(
      "Vyhľadajte lokalitu podľa názvu obce alebo poštového smerovacieho čísla.",
    );
  });

  it("uses separate loading, zero-result and service-error announcements", () => {
    expect(municipalityAutocompleteMessage("LOADING")).toBe("Hľadám lokality…");
    expect(municipalityAutocompleteMessage("ZERO")).toBe(
      "Lokalita ani PSČ sa nenašli.",
    );
    expect(municipalityAutocompleteMessage("ERROR")).toBe(
      "Návrhy lokalít sa momentálne nedajú načítať. Skúste to znova.",
    );
    expect(municipalityAutocompleteMessage("READY")).toBeNull();
  });

  it("wraps keyboard navigation deterministically in both directions", () => {
    expect(nextMunicipalityActiveIndex(-1, 3, 1)).toBe(0);
    expect(nextMunicipalityActiveIndex(0, 3, 1)).toBe(1);
    expect(nextMunicipalityActiveIndex(2, 3, 1)).toBe(0);
    expect(nextMunicipalityActiveIndex(-1, 3, -1)).toBe(2);
    expect(nextMunicipalityActiveIndex(0, 3, -1)).toBe(2);
    expect(nextMunicipalityActiveIndex(0, 0, 1)).toBe(-1);
    expect(municipalityKeyboardAction("ArrowDown", -1, 3, true)).toEqual({
      type: "MOVE",
      index: 0,
    });
    expect(municipalityKeyboardAction("Enter", 0, 3, true)).toEqual({
      type: "CHOOSE",
    });
    expect(municipalityKeyboardAction("Enter", -1, 3, true)).toBeNull();
    expect(municipalityKeyboardAction("Escape", 0, 3, true)).toEqual({
      type: "CLOSE",
    });
  });

  it("rejects stale and aborted responses even if a fetcher ignores abort", () => {
    expect(shouldApplyMunicipalityResponse(4, 3, false)).toBe(false);
    expect(shouldApplyMunicipalityResponse(4, 4, true)).toBe(false);
    expect(shouldApplyMunicipalityResponse(4, 4, false)).toBe(true);
  });

  it("invalidates both canonical municipality and postal selection after edit", () => {
    expect(municipalitySelectionAfterEdit("Prievidz")).toEqual({
      municipalityCode: "",
      query: "Prievidz",
      selectedPostalCode: null,
    });
  });

  it("keeps all municipality postal codes while prioritizing a numeric prefix", () => {
    expect(relevantPostalCodes(prievidza, "Prie")).toEqual([
      "97101",
      "97102",
      "97103",
    ]);
    expect(relevantPostalCodes(prievidza, "971 0")).toEqual([
      "97101",
      "97102",
      "97103",
    ]);
    expect(relevantPostalCodes(prievidza, "971 01")).toEqual(["97101"]);
  });

  it("adds the kraj suffix only when the source name omits it", () => {
    expect(formatRegionName("Trenčiansky")).toBe("Trenčiansky kraj");
    expect(formatRegionName("Bratislavský kraj")).toBe("Bratislavský kraj");
    expect(formatRegionName("Testovací KRAJ")).toBe("Testovací KRAJ");
  });
});
