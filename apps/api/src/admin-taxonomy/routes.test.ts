import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_TAXONOMY_CATALOG_PATHS,
  type AdminTaxonomyCatalogItem,
} from "./catalog-routes.js";
import { ADMIN_TAXONOMY_PATHS, registerAdminTaxonomyRoutes } from "./routes.js";

const adminId = "a9900000-0000-4000-8000-000000000001" as UserId;
const suggestionId = "a9900000-0000-4000-8000-000000000002";
const commandId = "a9900000-0000-4000-8000-000000000003";
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.taxonomy.manage"]),
  mfaAuthenticatedAt: new Date("2026-10-01T10:00:00.000Z"),
  roles: ["ADMIN"],
  userId: adminId,
};
const item: AdminTaxonomyCatalogItem = Object.freeze({
  aliases: Object.freeze(["elektrikar"]),
  code: "PROF:ELECTRICIAN",
  description: "Elektrické inštalácie a opravy.",
  kind: "PROFESSION",
  name: "Elektrikár",
  primaryProfessionCode: null,
  professionCodes: Object.freeze([]),
  releaseVersion: 4,
  replacedByCode: null,
  slug: "elektrikar",
  state: "ACTIVE",
});
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(input?: {
  csrf?: boolean;
  identity?: "ACTIVE" | "ANONYMOUS";
}) {
  const app = Fastify();
  apps.push(app);
  app.addHook("onRequest", (request, _reply, done) => {
    Object.defineProperty(request, "session", {
      configurable: true,
      value: { sessionId: "opaque-admin-session" },
    });
    done();
  });
  const authorize = vi.fn().mockResolvedValue({ actor, status: "AUTHORIZED" });
  const listCatalog = vi.fn().mockResolvedValue([item]);
  const findCatalogItem = vi.fn().mockResolvedValue(item);
  const findSimilar = vi.fn().mockResolvedValue([item]);
  const editItem = vi
    .fn()
    .mockResolvedValue({ item, status: "APPLIED" as const });
  const decide = vi.fn().mockResolvedValue({
    status: "APPLIED" as const,
    suggestion: {
      adminDecisionNote: null,
      createdAt: new Date("2026-10-01T09:00:00.000Z"),
      decidedAt: new Date("2026-10-01T10:01:00.000Z"),
      decidedByAdminId: adminId,
      id: suggestionId,
      normalizedProposedName: "servis tepelneho cerpadla",
      proposedDescription: "Pravidelný servis tepelného čerpadla.",
      proposedName: "Servis tepelného čerpadla",
      requesterCraftsmanProfileId: "a9900000-0000-4000-8000-000000000004",
      requesterUserId: "a9900000-0000-4000-8000-000000000005",
      resolvedTaxonomyCode: "SERV:HEAT_PUMP_SERVICE",
      resolvedTaxonomyLabel: "Servis tepelného čerpadla",
      revision: 2,
      state: "APPROVED_AS_NEW" as const,
      suggestedKind: "SERVICE" as const,
    },
  });
  registerAdminTaxonomyRoutes(app, {
    adminAccess: { authorize },
    catalog: { editItem, findCatalogItem, findSimilar, listCatalog },
    csrfProtection: (_request, reply, done) => {
      if (input?.csrf === false) {
        void reply.code(403).send({ code: "CSRF_DENIED" });
        return;
      }
      done();
    },
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          input?.identity === "ANONYMOUS"
            ? { status: "AUTHENTICATION_REQUIRED" }
            : { status: "ACTIVE", user: { id: adminId } },
        ),
    },
    persistence: {
      decide,
      findForAdmin: vi.fn().mockResolvedValue(null),
      listPending: vi.fn().mockResolvedValue([]),
      submit: vi.fn(),
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  return {
    app,
    authorize,
    decide,
    editItem,
    findCatalogItem,
    findSimilar,
    listCatalog,
  };
}

describe("admin taxonomy management", () => {
  it("lists and searches the managed catalog behind recent MFA", async () => {
    const { app, authorize, findSimilar, listCatalog } = fixture();
    const catalog = await app.inject({
      method: "GET",
      url:
        ADMIN_TAXONOMY_CATALOG_PATHS.catalog +
        "?kind=PROFESSION&state=ACTIVE&query=elektr&limit=12",
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.headers["cache-control"]).toBe("no-store");
    expect(catalog.json()).toEqual({ items: [item] });
    expect(listCatalog).toHaveBeenCalledWith({
      kind: "PROFESSION",
      limit: 12,
      query: "elektr",
      state: "ACTIVE",
    });
    expect(authorize).toHaveBeenCalledWith({
      capability: "admin.taxonomy.manage",
      requireRecentMfa: true,
      sessionId: "opaque-admin-session",
      userId: adminId,
    });

    const similar = await app.inject({
      method: "GET",
      url:
        ADMIN_TAXONOMY_CATALOG_PATHS.similar +
        "?query=elektrikar&kind=PROFESSION",
    });
    expect(similar.statusCode).toBe(200);
    expect(findSimilar).toHaveBeenCalledWith({
      kind: "PROFESSION",
      limit: 8,
      query: "elektrikar",
    });
  });

  it("rechecks recent MFA after reads and fails closed before disclosure", async () => {
    const { app, authorize } = fixture();
    authorize
      .mockResolvedValueOnce({ actor, status: "AUTHORIZED" })
      .mockResolvedValueOnce({ status: "MFA_TOO_OLD" });
    const response = await app.inject({
      method: "GET",
      url: ADMIN_TAXONOMY_CATALOG_PATHS.detail.replace(
        ":taxonomyCode",
        "PROF%3AELECTRICIAN",
      ),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "PRIVILEGED_ACCESS_DENIED" });
  });

  it("sends an exact, CSRF-protected immutable edit command and surfaces alias conflicts", async () => {
    const { app, editItem } = fixture();
    editItem.mockResolvedValueOnce({
      aliasConflicts: [
        {
          alias: "elektro servis",
          conflictingCode: "SERV:ELECTRICAL_REPAIR",
          conflictingKind: "SERVICE",
          conflictingName: "Oprava elektroinštalácie",
        },
      ],
      status: "ALIAS_CONFLICT",
    });
    const payload = {
      adminReason: "Spresnenie názvu podľa spravovaného katalógu.",
      aliases: ["elektro servis"],
      canonicalCode: "PROF:ELECTRICIAN",
      commandId,
      description: "Elektrické inštalácie, diagnostika a opravy.",
      expectedReleaseVersion: 4,
      kind: "PROFESSION",
      name: "Elektrikár",
      primaryProfessionCode: null,
      professionCodes: [],
      replacedByCode: null,
      state: "ACTIVE",
    } as const;
    const response = await app.inject({
      method: "POST",
      payload,
      url: ADMIN_TAXONOMY_CATALOG_PATHS.edit.replace(
        ":taxonomyCode",
        "PROF%3AELECTRICIAN",
      ),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: "ALIAS_CONFLICT" });
    expect(editItem).toHaveBeenCalledWith({
      actorAdminUserId: adminId,
      sourceTaxonomyCode: "PROF:ELECTRICIAN",
      ...payload,
    });

    const csrf = fixture({ csrf: false });
    expect(
      (
        await csrf.app.inject({
          method: "POST",
          payload,
          url: ADMIN_TAXONOMY_CATALOG_PATHS.edit.replace(
            ":taxonomyCode",
            "PROF%3AELECTRICIAN",
          ),
        })
      ).statusCode,
    ).toBe(403);
    expect(csrf.editItem).not.toHaveBeenCalled();

    const extra = fixture();
    expect(
      (
        await extra.app.inject({
          method: "POST",
          payload: { ...payload, unsafe: true },
          url: ADMIN_TAXONOMY_CATALOG_PATHS.edit.replace(
            ":taxonomyCode",
            "PROF%3AELECTRICIAN",
          ),
        })
      ).statusCode,
    ).toBe(400);
    expect(extra.editItem).not.toHaveBeenCalled();
  });

  it("passes explicit primary routing when approving a proposed service", async () => {
    const { app, decide } = fixture();
    const payload = {
      adminDecisionNote: null,
      aliases: ["servis tepelka"],
      canonicalCode: "SERV:HEAT_PUMP_SERVICE",
      canonicalDescription: "Pravidelný servis tepelného čerpadla.",
      canonicalKind: "SERVICE",
      canonicalName: "Servis tepelného čerpadla",
      commandId,
      expectedRevision: 1,
      primaryProfessionCode: "PROF:HEATING_ENGINEER",
      professionCodes: ["PROF:HEATING_ENGINEER"],
    } as const;
    const response = await app.inject({
      method: "POST",
      payload,
      url: ADMIN_TAXONOMY_PATHS.approve.replace(":suggestionId", suggestionId),
    });
    expect(response.statusCode).toBe(200);
    expect(decide).toHaveBeenCalledWith({
      actorAdminUserId: adminId,
      decision: "APPROVED_AS_NEW",
      suggestionId,
      ...payload,
    });
  });

  it("denies anonymous and stale-MFA requests", async () => {
    const anonymous = fixture({ identity: "ANONYMOUS" });
    expect(
      (
        await anonymous.app.inject({
          method: "GET",
          url: ADMIN_TAXONOMY_CATALOG_PATHS.catalog,
        })
      ).statusCode,
    ).toBe(401);
    const denied = fixture();
    denied.authorize.mockResolvedValue({ status: "MFA_TOO_OLD" });
    expect(
      (
        await denied.app.inject({
          method: "GET",
          url: ADMIN_TAXONOMY_CATALOG_PATHS.catalog,
        })
      ).statusCode,
    ).toBe(403);
  });
});
