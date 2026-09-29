import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ConversationsPage from "./app/konverzacie/page";

describe("conversations entry page", () => {
  it("routes users honestly to contextual job conversations", () => {
    const html = renderToStaticMarkup(<ConversationsPage />);

    expect(html).toContain('id="main-content"');
    expect(html).toContain("Správy nájdete pri zákazke");
    expect(html).toContain('href="/zakazky"');
    expect(html).not.toContain("Nová správa");
    expect(html).not.toContain("Nečakajú na vás žiadne správy");
  });
});
