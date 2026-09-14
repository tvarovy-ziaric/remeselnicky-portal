import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import {
  CUSTOMER_SHORTLIST_PATHS,
  registerCustomerShortlistRoutes,
} from "./routes.js";

const actorUserId = "93000000-0000-4000-8000-000000000001" as UserId;
const profileId = "93000000-0000-4000-8000-000000000002";
const commandId = "93000000-0000-4000-8000-000000000003";
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("customer shortlist routes", () => {
  it("returns only owner-safe membership and unavailable tombstone fields", async () => {
    const app = Fastify();
    apps.push(app);
    registerCustomerShortlistRoutes(
      app,
      dependencies({
        list: vi.fn(() =>
          Promise.resolve({
            entries: [
              {
                craftsmanProfileId: profileId,
                revision: 2,
                savedAt: new Date("2026-09-15T08:00:00Z"),
                targetAvailable: false,
              },
            ],
            status: "OK",
          }),
        ),
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: CUSTOMER_SHORTLIST_PATHS.list,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      items: [
        {
          availability: "UNAVAILABLE",
          craftsmanProfileId: profileId,
          revision: 2,
          savedAt: "2026-09-15T08:00:00.000Z",
        },
      ],
    });
    expect(response.body).not.toMatch(
      /owner|email|phone|address|distance|rank/iu,
    );
  });

  it("derives the actor and never forwards client ownership fields", async () => {
    const add = vi.fn(() =>
      Promise.resolve({
        revision: 1,
        state: "ACTIVE",
        status: "APPLIED",
      } as const),
    );
    const app = Fastify();
    apps.push(app);
    registerCustomerShortlistRoutes(app, dependencies({ add }));

    const response = await app.inject({
      method: "POST",
      url: CUSTOMER_SHORTLIST_PATHS.add,
      payload: { actorUserId, commandId, craftsmanProfileId: profileId },
    });
    expect(response.statusCode).toBe(204);
    expect(add).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      craftsmanProfileId: profileId,
    });
  });

  it("denies anonymous reads and maps unavailable targets without disclosure", async () => {
    const app = Fastify();
    apps.push(app);
    registerCustomerShortlistRoutes(app, {
      ...dependencies(),
      guard: {
        evaluate: vi.fn(() =>
          Promise.resolve({ status: "AUTHENTICATION_REQUIRED" as const }),
        ),
      },
    });
    expect(
      (await app.inject({ method: "GET", url: CUSTOMER_SHORTLIST_PATHS.list }))
        .statusCode,
    ).toBe(401);
  });

  it("emits only committed APPLIED transitions and ignores analytics failure", async () => {
    const onApplied = vi.fn(() => Promise.reject(new Error("analytics down")));
    const add = vi.fn(() =>
      Promise.resolve({
        activeShortlistSize: 3,
        revision: 1,
        state: "ACTIVE",
        status: "APPLIED",
      } as const),
    );
    const remove = vi.fn(() =>
      Promise.resolve({
        revision: 1,
        state: "ACTIVE",
        status: "UNCHANGED",
      } as const),
    );
    const app = Fastify();
    apps.push(app);
    registerCustomerShortlistRoutes(
      app,
      dependencies({ add, remove }, { onApplied }),
    );

    const applied = await app.inject({
      method: "POST",
      payload: { commandId, craftsmanProfileId: profileId },
      url: CUSTOMER_SHORTLIST_PATHS.add,
    });
    const unchanged = await app.inject({
      method: "POST",
      payload: {
        commandId: "93000000-0000-4000-8000-000000000004",
        craftsmanProfileId: profileId,
      },
      url: CUSTOMER_SHORTLIST_PATHS.remove,
    });

    expect(applied.statusCode).toBe(204);
    expect(unchanged.statusCode).toBe(204);
    expect(onApplied).toHaveBeenCalledOnce();
    expect(onApplied).toHaveBeenCalledWith({
      activeShortlistSize: 3,
      actorUserId,
      commandId,
      state: "ACTIVE",
    });
  });
});

function dependencies(
  overrides: Record<string, unknown> = {},
  routeOverrides: Record<string, unknown> = {},
) {
  return {
    csrfProtection: (_request: unknown, _reply: unknown, done: () => void) =>
      done(),
    guard: {
      evaluate: vi.fn(() =>
        Promise.resolve({
          status: "ACTIVE" as const,
          user: { id: actorUserId },
        }),
      ),
    },
    shortlist: {
      add: vi.fn(),
      list: vi.fn(() =>
        Promise.resolve({ entries: [], status: "OK" as const }),
      ),
      remove: vi.fn(),
      ...overrides,
    },
    ...routeOverrides,
  } as Parameters<typeof registerCustomerShortlistRoutes>[1];
}
