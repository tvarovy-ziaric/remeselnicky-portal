import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createCustomerShortlistStore } from "./customer-shortlist-store";
import {
  CustomerShortlistProvider,
  CustomerShortlistToggle,
} from "./customer-shortlist-toggle";

describe("CustomerShortlistToggle", () => {
  it("renders an accessible disabled loading control before private state loads", () => {
    const html = renderToStaticMarkup(
      <CustomerShortlistToggle craftsmanProfileId="94000000-0000-4000-8000-000000000001" />,
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("Načítavam výber");
    expect(html).not.toMatch(/customerProfileId|ownerUserId|expectedRevision/u);
  });

  it("shares one session/list load across two toggles and reflects an applied add", async () => {
    const first = "94000000-0000-4000-8000-000000000011";
    const second = "94000000-0000-4000-8000-000000000012";
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url === "/v1/auth/session") {
        return Promise.resolve(Response.json({ csrfToken: "csrf-test" }));
      }
      if (url === "/v1/me/shortlist") {
        return Promise.resolve(
          Response.json({ items: [{ craftsmanProfileId: second }] }),
        );
      }
      if (url === "/v1/me/shortlist/add") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    });
    const store = createCustomerShortlistStore({
      commandId: () => "94000000-0000-4000-8000-000000000013",
      fetch: fetcher,
    });
    const view = () =>
      renderToStaticMarkup(
        <CustomerShortlistProvider store={store}>
          <CustomerShortlistToggle craftsmanProfileId={first} />
          <CustomerShortlistToggle craftsmanProfileId={second} />
        </CustomerShortlistProvider>,
      );

    expect(view().match(/Načítavam výber/g)).toHaveLength(2);
    await Promise.all([store.load(), store.load()]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      "/v1/auth/session",
      "/v1/me/shortlist",
    ]);
    expect(view().match(/aria-pressed="true"/g)).toHaveLength(1);

    await store.toggle(first);

    expect(fetcher).toHaveBeenCalledTimes(3);
    const appliedRequest = fetcher.mock.calls[2]?.[0];
    expect(
      appliedRequest === undefined ? undefined : requestUrl(appliedRequest),
    ).toBe("/v1/me/shortlist/add");
    expect(view().match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(view().match(/Odobrať z výberu/g)).toHaveLength(2);
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
