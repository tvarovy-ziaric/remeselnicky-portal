import { describe, expect, it } from "vitest";

import {
  parseAdminModule,
  parseAdminModules,
  parseAdminSession,
} from "./admin-shell-model";

describe("admin shell response boundary", () => {
  it("accepts the minimal MFA-backed privileged projection", () => {
    expect(
      parseAdminSession({
        capabilities: ["admin.access", "admin.profiles.review"],
        mfaAuthenticatedAt: "2026-09-14T10:00:00.000Z",
        roles: ["ADMIN"],
      }),
    ).toBeDefined();
  });

  it.each([
    undefined,
    {},
    { capabilities: [], mfaAuthenticatedAt: "invalid", roles: ["ADMIN"] },
    {
      capabilities: ["admin.profiles.review"],
      mfaAuthenticatedAt: "2026-09-14T10:00:00.000Z",
      roles: ["ADMIN"],
    },
    {
      capabilities: ["admin.access"],
      mfaAuthenticatedAt: "2026-09-14T10:00:00.000Z",
      roles: ["USER"],
    },
  ])("rejects malformed or non-privileged session data", (value) => {
    expect(parseAdminSession(value)).toBeUndefined();
  });

  it("accepts only the explicit operational module allowlist", () => {
    expect(
      parseAdminModules({
        modules: [
          {
            description: "Prevádzkové fronty Web Alpha.",
            id: "dashboard",
            label: "Prehľad",
          },
        ],
      }),
    ).toHaveLength(1);
    expect(
      parseAdminModules({
        modules: [
          {
            description: "Do not expose this.",
            id: "raw-database",
            label: "SQL",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("binds a deep-link response to the requested module", () => {
    const response = {
      description: "Nemenná história privilegovaných operácií.",
      id: "audit",
      label: "Audit",
      state: "PLACEHOLDER",
    };

    expect(parseAdminModule(response, "audit")?.id).toBe("audit");
    expect(parseAdminModule(response, "profiles")).toBeUndefined();
    expect(
      parseAdminModule({ ...response, state: "READY" }, "audit"),
    ).toBeUndefined();
    expect(
      parseAdminModule(
        {
          description: "Otvorené prípady a spory.",
          id: "disputes",
          label: "Spory",
          state: "OPERATIONAL",
        },
        "disputes",
      )?.id,
    ).toBe("disputes");
    expect(
      parseAdminModule({ ...response, id: "disputes" }, "disputes"),
    ).toBeUndefined();
  });
});
