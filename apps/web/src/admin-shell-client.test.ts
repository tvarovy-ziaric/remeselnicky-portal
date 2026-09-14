import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAdminShell } from "./admin-shell-client";

const session = {
  capabilities: ["admin.access", "admin.sensitive.read"],
  mfaAuthenticatedAt: "2026-09-14T10:00:00.000Z",
  roles: ["SUPER_ADMIN"],
};
const modules = {
  modules: [
    {
      description: "Prevádzkové fronty Web Alpha.",
      id: "dashboard",
      label: "Prehľad",
    },
    {
      description: "Nemenná história privilegovaných operácií.",
      id: "audit",
      label: "Audit",
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("admin shell loader", () => {
  it("re-authorizes a deep link through its backend module endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(modules))
      .mockResolvedValueOnce(
        jsonResponse({
          description: "Nemenná história privilegovaných operácií.",
          id: "audit",
          label: "Audit",
          state: "PLACEHOLDER",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadAdminShell("audit", new AbortController().signal);

    expect(result.status).toBe("AUTHORIZED");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/admin/console/modules/audit",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it.each([403, 404])(
    "renders the same denied state for a %s deep-link response",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(jsonResponse(session))
          .mockResolvedValueOnce(jsonResponse(modules))
          .mockResolvedValueOnce(new Response(null, { status })),
      );

      await expect(
        loadAdminShell("audit", new AbortController().signal),
      ).resolves.toEqual({ status: "ACCESS_DENIED" });
    },
  );

  it("fails closed when the API/provider wiring is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    );

    await expect(
      loadAdminShell("dashboard", new AbortController().signal),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
