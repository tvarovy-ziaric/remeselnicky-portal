import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerTaxonomySuggestionRoutes,
  TAXONOMY_SUGGESTION_PATHS,
  type TaxonomySuggestionRouteDependencies,
} from "./routes.js";

const actorUserId = "95000000-0000-4000-8000-000000000001";
const profileId = "95000000-0000-4000-8000-000000000002";
const suggestionId = "95000000-0000-4000-8000-000000000003";
const commandId = "95000000-0000-4000-8000-000000000004";
const suggestion = {
  adminDecisionNote: null,
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
  decidedAt: null,
  decidedByAdminId: null,
  id: suggestionId,
  normalizedProposedName: "montaz inteligentnej zasuvky",
  proposedDescription: "Montáž a servis inteligentných zásuviek.",
  proposedName: "Montáž inteligentnej zásuvky",
  requesterCraftsmanProfileId: profileId,
  requesterUserId: actorUserId,
  resolvedTaxonomyCode: null,
  resolvedTaxonomyLabel: null,
  revision: 1,
  state: "PENDING" as const,
  suggestedKind: "SERVICE" as const,
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("owner taxonomy suggestion routes", () => {
  it("submits a CSRF-protected suggestion as the active publishing actor", async () => {
    const { app, csrf, evaluate, submit } = apiWith();
    const response = await app.inject({
      method: "POST",
      payload: validBody(),
      url: TAXONOMY_SUGGESTION_PATHS.submit.replace(":profileId", profileId),
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      status: "APPLIED",
      suggestion: {
        adminDecisionNote: null,
        createdAt: "2026-10-01T12:00:00.000Z",
        decidedAt: null,
        id: suggestionId,
        proposedDescription: suggestion.proposedDescription,
        proposedName: suggestion.proposedName,
        resolvedTaxonomyCode: null,
        resolvedTaxonomyLabel: null,
        revision: 1,
        state: "PENDING",
        suggestedKind: "SERVICE",
      },
    });
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), "PUBLISHING");
    expect(submit).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      normalizedProposedName: "montaz inteligentnej zasuvky",
      proposedDescription: suggestion.proposedDescription,
      proposedName: suggestion.proposedName,
      requesterCraftsmanProfileId: profileId,
      suggestedKind: "SERVICE",
      suggestionId,
    });
    expect(csrf).toHaveBeenCalledOnce();
    expect(response.body).not.toContain(actorUserId);
    expect(response.body).not.toContain("decidedByAdminId");
  });

  it("reads only the actor-owned minimized suggestion", async () => {
    const { app, findOwned } = apiWith();
    const response = await app.inject({
      method: "GET",
      url: TAXONOMY_SUGGESTION_PATHS.detail.replace(
        ":suggestionId",
        suggestionId,
      ),
    });
    expect(response.statusCode).toBe(200);
    expect(findOwned).toHaveBeenCalledWith(actorUserId, suggestionId);
    expect(response.body).not.toContain(actorUserId);

    findOwned.mockResolvedValueOnce(null);
    const unavailable = await app.inject({
      method: "GET",
      url: TAXONOMY_SUGGESTION_PATHS.detail.replace(
        ":suggestionId",
        suggestionId,
      ),
    });
    expect(unavailable.statusCode).toBe(404);
  });

  it("fails closed for anonymous actors, extra input and persistence errors", async () => {
    const anonymous = apiWith({
      guard: {
        evaluate: vi.fn(() =>
          Promise.resolve({ status: "AUTHENTICATION_REQUIRED" as const }),
        ),
      },
    });
    expect(
      (
        await anonymous.app.inject({
          method: "POST",
          payload: validBody(),
          url: TAXONOMY_SUGGESTION_PATHS.submit.replace(
            ":profileId",
            profileId,
          ),
        })
      ).statusCode,
    ).toBe(401);
    expect(anonymous.csrf).toHaveBeenCalledOnce();

    const invalid = apiWith();
    expect(
      (
        await invalid.app.inject({
          method: "POST",
          payload: { ...validBody(), requesterUserId: actorUserId },
          url: TAXONOMY_SUGGESTION_PATHS.submit.replace(
            ":profileId",
            profileId,
          ),
        })
      ).statusCode,
    ).toBe(400);
    expect(invalid.submit).not.toHaveBeenCalled();

    invalid.submit.mockRejectedValueOnce(
      new Error("private persistence detail"),
    );
    const unavailable = await invalid.app.inject({
      method: "POST",
      payload: validBody(),
      url: TAXONOMY_SUGGESTION_PATHS.submit.replace(":profileId", profileId),
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("private persistence detail");
  });
});

function validBody() {
  return {
    commandId,
    proposedDescription: suggestion.proposedDescription,
    proposedName: suggestion.proposedName,
    suggestedKind: suggestion.suggestedKind,
    suggestionId,
  };
}

function apiWith(overrides: Partial<TaxonomySuggestionRouteDependencies> = {}) {
  const csrf = vi.fn((_request, _reply, done: () => void) => done());
  const evaluate = vi.fn(() =>
    Promise.resolve({
      status: "ACTIVE" as const,
      user: { id: actorUserId },
    }),
  );
  const findOwned = vi.fn<() => Promise<typeof suggestion | null>>(() =>
    Promise.resolve(suggestion),
  );
  const submit = vi.fn(() =>
    Promise.resolve({ status: "APPLIED" as const, suggestion }),
  );
  const dependencies = {
    csrfProtection: csrf,
    guard: {
      evaluate,
    },
    persistence: {
      decide: vi.fn(),
      findOwned,
      submit,
    },
    rateLimit: { max: 10, timeWindowMs: 60_000 },
    ...overrides,
  } as unknown as TaxonomySuggestionRouteDependencies & {
    readonly guard: { readonly evaluate: ReturnType<typeof vi.fn> };
    readonly persistence: {
      readonly findOwned: ReturnType<typeof vi.fn>;
      readonly submit: ReturnType<typeof vi.fn>;
    };
  };
  const app = Fastify();
  registerTaxonomySuggestionRoutes(app, dependencies);
  apps.push(app);
  return { app, csrf, dependencies, evaluate, findOwned, submit };
}
