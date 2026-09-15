import type { QuoteId, UserId } from "@portal/domain";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUOTE_LIFECYCLE_PATHS,
  registerQuoteLifecycleRoutes,
} from "./routes.js";

const actorUserId = "86100000-0000-4000-8000-000000000001" as UserId;
const quoteId = "86100000-0000-4000-8000-000000000002" as QuoteId;
const commandId = "86100000-0000-4000-8000-000000000003";
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("Quote lifecycle routes", () => {
  it("derives the provider actor, applies CSRF and exposes no system EXPIRE route", async () => {
    const withdraw = vi.fn(() =>
      Promise.resolve({
        context: context("WITHDRAWN", false),
        status: "APPLIED" as const,
      }),
    );
    const csrf = vi.fn(
      (
        _request: FastifyRequest,
        _reply: FastifyReply,
        done: HookHandlerDoneFunction,
      ): void => done(),
    );
    const app = build({ csrf, withdraw });
    const response = await app.inject({
      method: "POST",
      payload: { commandId, expectedStateRevision: 2, quoteRevision: 1 },
      url: path(QUOTE_LIFECYCLE_PATHS.withdraw),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(csrf).toHaveBeenCalledOnce();
    expect(withdraw).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      expectedStateRevision: 2,
      quoteId,
      quoteRevision: 1,
    });
    expect(
      await app.inject({
        method: "POST",
        url: `/v1/me/quotes/${quoteId}/expire`,
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("passes exact terminal-source CAS for reconfirm and returns only new draft identity", async () => {
    const reconfirm = vi.fn(() =>
      Promise.resolve({
        quote: { currentDraft: { revision: 4 }, id: quoteId },
        status: "APPLIED" as const,
      }),
    );
    const app = build({ reconfirm });
    const response = await app.inject({
      method: "POST",
      payload: {
        authoringMode: "EXTERNAL_PDF",
        commandId,
        expectedSourceStateRevision: 3,
        sourceQuoteRevision: 2,
        sourceState: "EXPIRED",
      },
      url: path(QUOTE_LIFECYCLE_PATHS.reconfirm),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      draftRevision: 4,
      quoteId,
      status: "APPLIED",
    });
    expect(reconfirm).toHaveBeenCalledWith({
      actorUserId,
      authoringMode: "EXTERNAL_PDF",
      commandId,
      expectedSourceStateRevision: 3,
      quoteId,
      sourceQuoteRevision: 2,
      sourceState: "EXPIRED",
    });
  });

  it("uses uniform denial for customer/competitor and blocks suspended actors before persistence", async () => {
    const withdraw = vi.fn(() =>
      Promise.resolve({ status: "NOT_FOUND" as const }),
    );
    const app = build({ withdraw });
    expect(
      (
        await app.inject({
          method: "POST",
          payload: { commandId, expectedStateRevision: 2, quoteRevision: 1 },
          url: path(QUOTE_LIFECYCLE_PATHS.withdraw),
        })
      ).statusCode,
    ).toBe(404);
    const denied = build({ status: "ACCOUNT_NOT_ACTIVE", withdraw });
    expect(
      (
        await denied.inject({
          method: "POST",
          payload: { commandId, expectedStateRevision: 2, quoteRevision: 1 },
          url: path(QUOTE_LIFECYCLE_PATHS.withdraw),
        })
      ).statusCode,
    ).toBe(403);
    expect(withdraw).toHaveBeenCalledTimes(1);
  });
});

function build(overrides: {
  csrf?: ReturnType<typeof vi.fn>;
  reconfirm?: ReturnType<typeof vi.fn>;
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  withdraw?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  apps.push(app);
  registerQuoteLifecycleRoutes(app, {
    csrfProtection: (overrides.csrf ??
      vi.fn(
        (
          _request: FastifyRequest,
          _reply: FastifyReply,
          done: HookHandlerDoneFunction,
        ): void => done(),
      )) as never,
    guard: {
      evaluate: vi.fn(() =>
        Promise.resolve(
          overrides.status === undefined || overrides.status === "ACTIVE"
            ? { status: "ACTIVE" as const, user: { id: actorUserId } }
            : { status: overrides.status },
        ),
      ),
    },
    lifecycle: {
      readOwnedContext: vi.fn(() =>
        Promise.resolve(context("SUBMITTED", true)),
      ),
      reconfirm:
        overrides.reconfirm ??
        vi.fn(() => Promise.resolve({ status: "STALE_REVISION" as const })),
      withdraw:
        overrides.withdraw ??
        vi.fn(() => Promise.resolve({ status: "NOT_FOUND" as const })),
    },
  });
  return app;
}
function path(template: string) {
  return template.replace(":quoteId", quoteId);
}
function context(
  state: "SUBMITTED" | "WITHDRAWN",
  lifecycleAcceptanceEligible: boolean,
) {
  return {
    authoringEligible: true,
    authoringMode: "PLATFORM_STRUCTURED" as const,
    currentRequestContentRevision: 2,
    currentRequestVisibleVersion: 1,
    deadlinePassed: false,
    lifecycleAcceptanceEligible,
    materiallyStale: false,
    quoteId,
    quoteRevision: 1,
    requestContentRevision: 1,
    requestVisibleVersion: 1,
    state,
    stateRevision: state === "SUBMITTED" ? 2 : 3,
    validUntil: null,
  };
}
