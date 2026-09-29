import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  humanizeCode,
  PortfolioPhotoPrivacyNotice,
  PortfolioProvenanceNotice,
} from "./craftsman-portfolio";

describe("craftsman portfolio presentation", () => {
  it("keeps self-declared work distinct from verified platform work", () => {
    const html = renderToStaticMarkup(<PortfolioProvenanceNotice />);
    expect(html).toContain("vlastné vyhlásenie");
    expect(html).toContain("Nejde o overenú realizáciu z platformy");
    expect(html).not.toContain("Overené platformou");
  });

  it("explains private processing and separate customer consent", () => {
    const html = renderToStaticMarkup(<PortfolioPhotoPrivacyNotice />);
    expect(html).toContain("Súbory zostávajú súkromné");
    expect(html).toContain("EXIF/GPS");
    expect(html).toContain("samostatný výslovný súhlas zákazníka");
  });

  it("does not present taxonomy codes verbatim", () => {
    expect(humanizeCode("ROOFING_SPECIALIST")).toBe("Roofing specialist");
    expect(humanizeCode("trade.woodwork")).toBe("Woodwork");
  });
});
