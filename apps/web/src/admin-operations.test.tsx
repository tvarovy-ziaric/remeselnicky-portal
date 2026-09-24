import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminDisputeWorkspace, AdminJobOperations } from "./admin-operations";

describe("admin operational workspaces", () => {
  it("explains the audited dispute boundary before loading sensitive data", () => {
    const html = renderToStaticMarkup(<AdminDisputeWorkspace />);
    expect(html).toContain("Sporné prípady");
    expect(html).toContain("nemení zmluvu, peniaze ani právne nároky");
    expect(html).toContain("Dôvod prístupu k citlivým údajom");
  });

  it("offers only explicit exceptional Job commands", () => {
    const html = renderToStaticMarkup(<AdminJobOperations />);
    expect(html).toContain("Výnimočne dokončiť");
    expect(html).toContain("Výnimočne zrušiť");
    expect(html).toContain("Nie je tu generické nastavenie stavu");
    expect(html).not.toContain("Nastaviť stav");
  });
});
