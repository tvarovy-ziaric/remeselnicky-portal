import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import JobRequestPage from "./app/dopyt/page";

describe("job request page shell", () => {
  it("keeps the recoverable wizard inside a session-aware product shell", () => {
    const html = renderToStaticMarkup(<JobRequestPage />);

    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="Hlavná navigácia"');
    expect(html).not.toContain("Prihlásiť sa");
    expect(html).toContain("Obnovujem váš dopyt");
    expect(html).toContain("Jednoduchšie hľadanie remeselníkov");
  });
});
