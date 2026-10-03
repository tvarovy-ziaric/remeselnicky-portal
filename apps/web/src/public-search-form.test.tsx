import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PublicSearchForm,
  publicSearchLookupMessage,
  publicSearchMunicipalityMessage,
} from "./public-search-form";

describe("PublicSearchForm", () => {
  it("starts without a false empty state or an arbitrary profession code", () => {
    const html = renderToStaticMarkup(<PublicSearchForm />);

    expect(html).toContain("Začnite písať a vyberte návrh zo zoznamu.");
    expect(html).not.toContain('name="professionCode"');
    expect(html).not.toContain('name="municipalityCode"');
    expect(html).not.toContain('role="status"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("Obec alebo PSČ");
    expect(html.match(/role="combobox"/gu)).toHaveLength(2);
    expect(html).toContain(
      "Vyhľadajte lokalitu podľa názvu obce alebo poštového smerovacieho čísla.",
    );
    expect(html).toContain("Zoradiť výsledky");
    expect(html).toContain("Najbližší");
    expect(html).toContain("Zobraziť aj remeselníkov mimo ich bežného dosahu");
    expect(html).toContain(
      "Výsledky automaticky rešpektujú dojazd nastavený remeselníkmi.",
    );
  });

  it("restores a submitted service, municipality and geo controls", () => {
    const html = renderToStaticMarkup(
      <PublicSearchForm
        initialValues={{
          includeOutsideDeclaredArea: true,
          municipalityCode: "SK:BA:BRATISLAVA",
          municipalityLabel: "Bratislava",
          professionCode: "PROF:TILER",
          professionLabel: "Pokládka dlažby",
          serviceCode: "SERV:TILING",
          sort: "NEAREST",
        }}
      />,
    );

    expect(html).toContain('name="professionCode"');
    expect(html).toContain('value="PROF:TILER"');
    expect(html).toContain('name="serviceCode"');
    expect(html).toContain('value="SERV:TILING"');
    expect(html).toContain('name="municipalityCode"');
    expect(html).toContain('value="SK:BA:BRATISLAVA"');
    expect(html).toContain('name="professionLabel"');
    expect(html).toContain('name="municipalityLabel"');
    expect(html).toContain('value="NEAREST" selected=""');
    expect(html).toContain('name="includeOutsideDeclaredArea"');
    expect(html).toContain('checked=""');
  });

  it("preserves only the opaque Job identifier across profession searches", () => {
    const html = renderToStaticMarkup(
      <PublicSearchForm jobId="99000000-0000-4000-8000-000000000020" />,
    );
    expect(html).toContain('name="jobId"');
    expect(html).toContain('value="99000000-0000-4000-8000-000000000020"');
    expect(html).not.toMatch(/jobRequestId|customer|exactAddress|contact/iu);
    const ambiguous = renderToStaticMarkup(
      <PublicSearchForm
        jobId="99000000-0000-4000-8000-000000000020"
        jobRequestId="99000000-0000-4000-8000-000000000010"
      />,
    );
    expect(ambiguous).not.toMatch(/name="jobId"|name="jobRequestId"/u);
  });

  it("announces loading and an empty governed suggestion response", () => {
    expect(publicSearchLookupMessage(null)).toBeNull();
    expect(
      publicSearchLookupMessage({
        query: "oprava",
        status: "loading",
        items: [],
      }),
    ).toBe("Hľadáme profesie a služby…");
    expect(
      publicSearchLookupMessage({
        query: "oprava",
        status: "ready",
        items: [],
      }),
    ).toContain("Momentálne nemáme návrh");
    expect(
      publicSearchLookupMessage({
        query: "obkladač",
        status: "ready",
        items: [
          {
            code: "PROF:TILER",
            kind: "PROFESSION",
            label: "Obkladač",
            memberCount: 0,
            professionCodes: ["PROF:TILER"],
          },
        ],
      }),
    ).toBeNull();
  });

  it("describes optional municipality lookup without exposing an address", () => {
    expect(publicSearchMunicipalityMessage(null)).toBeNull();
    expect(
      publicSearchMunicipalityMessage({
        query: "Trn",
        status: "loading",
        items: [],
      }),
    ).toBe("Hľadám lokality…");
    expect(
      publicSearchMunicipalityMessage({
        query: "Nenájdená obec",
        status: "ready",
        items: [],
      }),
    ).toBe("Lokalita ani PSČ sa nenašli.");
    expect(
      publicSearchMunicipalityMessage({
        query: "Prie",
        status: "error",
        items: [],
      }),
    ).toBe("Návrhy lokalít sa momentálne nedajú načítať. Skúste to znova.");
  });
});
