import type { AdminAccessService } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preValidationHookHandler,
} from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";

export const ADMIN_TAXONOMY_CATALOG_PATHS = Object.freeze({
  catalog: "/v1/admin/taxonomy/catalog",
  detail: "/v1/admin/taxonomy/catalog/:taxonomyCode",
  edit: "/v1/admin/taxonomy/catalog/:taxonomyCode/edit",
  similar: "/v1/admin/taxonomy/catalog-similar",
});

export type AdminTaxonomyKind = "PROFESSION" | "SERVICE";
export type AdminTaxonomyState = "ACTIVE" | "DEPRECATED";

export interface AdminTaxonomyCatalogItem {
  readonly aliases: readonly string[];
  readonly code: string;
  readonly description: string | null;
  readonly kind: AdminTaxonomyKind;
  readonly name: string;
  readonly primaryProfessionCode: string | null;
  readonly professionCodes: readonly string[];
  readonly releaseVersion: number;
  readonly replacedByCode: string | null;
  readonly slug: string;
  readonly state: AdminTaxonomyState;
}

export interface AdminTaxonomyAliasConflict {
  readonly alias: string;
  readonly conflictingCode: string;
  readonly conflictingKind: AdminTaxonomyKind;
  readonly conflictingName: string;
}

export interface EditAdminTaxonomyItemInput {
  readonly actorAdminUserId: string;
  readonly adminReason: string;
  readonly aliases: readonly string[];
  readonly canonicalCode: string;
  readonly commandId: string;
  readonly description: string | null;
  readonly expectedReleaseVersion: number;
  readonly kind: AdminTaxonomyKind;
  readonly name: string;
  readonly primaryProfessionCode: string | null;
  readonly professionCodes: readonly string[];
  readonly replacedByCode: string | null;
  readonly sourceTaxonomyCode: string;
  readonly state: AdminTaxonomyState;
}

export type EditAdminTaxonomyItemResult = Readonly<
  | {
      aliasConflicts: readonly AdminTaxonomyAliasConflict[];
      status: "ALIAS_CONFLICT";
    }
  | {
      code:
        | "CANONICAL_CODE_CONFLICT"
        | "DEPENDENCIES_EXIST"
        | "ITEM_UNAVAILABLE"
        | "REPLACEMENT_UNAVAILABLE"
        | "STALE_RELEASE";
      status: "CONFLICT";
    }
  | {
      item: AdminTaxonomyCatalogItem;
      status: "APPLIED" | "DEDUPLICATED";
    }
>;

export interface AdminTaxonomyCatalogRepository {
  editItem(
    input: EditAdminTaxonomyItemInput,
  ): Promise<EditAdminTaxonomyItemResult>;
  findCatalogItem(
    taxonomyCode: string,
  ): Promise<AdminTaxonomyCatalogItem | null>;
  findSimilar(input: {
    readonly kind: AdminTaxonomyKind | null;
    readonly limit: number;
    readonly query: string;
  }): Promise<readonly AdminTaxonomyCatalogItem[]>;
  listCatalog(input: {
    readonly kind: AdminTaxonomyKind | null;
    readonly limit: number;
    readonly query: string | null;
    readonly state: AdminTaxonomyState | null;
  }): Promise<readonly AdminTaxonomyCatalogItem[]>;
}

export interface AdminTaxonomyCatalogRouteDependencies {
  readonly adminAccess: Pick<AdminAccessService, "authorize">;
  readonly catalog: AdminTaxonomyCatalogRepository;
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerAdminTaxonomyCatalogRoutes(
  app: FastifyInstance,
  dependencies: AdminTaxonomyCatalogRouteDependencies,
): void {
  const config = rateLimitConfig(dependencies);

  app.get<{
    Querystring: {
      kind?: AdminTaxonomyKind;
      limit?: number;
      query?: string;
      state?: AdminTaxonomyState;
    };
  }>(
    ADMIN_TAXONOMY_CATALOG_PATHS.catalog,
    {
      config,
      onSend: noStore,
      schema: { querystring: catalogQuerySchema },
    },
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const items = await dependencies.catalog.listCatalog({
          kind: request.query.kind ?? null,
          limit: request.query.limit ?? 300,
          query: normalizeOptionalQuery(request.query.query),
          state: request.query.state ?? null,
        });
        if (!(await stillAuthorized(request, actor, dependencies))) {
          return denied(reply);
        }
        return reply.send({ items });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.get<{
    Querystring: { kind?: AdminTaxonomyKind; limit?: number; query: string };
  }>(
    ADMIN_TAXONOMY_CATALOG_PATHS.similar,
    {
      config,
      onSend: noStore,
      schema: { querystring: similarQuerySchema },
    },
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const items = await dependencies.catalog.findSimilar({
          kind: request.query.kind ?? null,
          limit: request.query.limit ?? 8,
          query: request.query.query,
        });
        if (!(await stillAuthorized(request, actor, dependencies))) {
          return denied(reply);
        }
        return reply.send({ items });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.get<{ Params: { taxonomyCode: string } }>(
    ADMIN_TAXONOMY_CATALOG_PATHS.detail,
    {
      config,
      onSend: noStore,
      preValidation: rejectQuery,
      schema: { params: catalogParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const item = await dependencies.catalog.findCatalogItem(
          request.params.taxonomyCode,
        );
        if (!(await stillAuthorized(request, actor, dependencies))) {
          return denied(reply);
        }
        return item === null ? notFound(reply) : reply.send({ item });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.post<{ Body: EditBody; Params: { taxonomyCode: string } }>(
    ADMIN_TAXONOMY_CATALOG_PATHS.edit,
    {
      config,
      onRequest: dependencies.csrfProtection,
      onSend: noStore,
      preValidation: [rejectQuery, exactBody(editKeys)],
      schema: {
        body: editSchema,
        params: catalogParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const result = await dependencies.catalog.editItem({
          actorAdminUserId: actor,
          adminReason: request.body.adminReason,
          aliases: request.body.aliases,
          canonicalCode: request.body.canonicalCode,
          commandId: request.body.commandId,
          description: request.body.description,
          expectedReleaseVersion: request.body.expectedReleaseVersion,
          kind: request.body.kind,
          name: request.body.name,
          primaryProfessionCode: request.body.primaryProfessionCode,
          professionCodes: request.body.professionCodes,
          replacedByCode: request.body.replacedByCode,
          sourceTaxonomyCode: request.params.taxonomyCode,
          state: request.body.state,
        });
        return result.status === "APPLIED" || result.status === "DEDUPLICATED"
          ? reply.send(result)
          : reply.code(409).send(result);
      } catch (error: unknown) {
        return error instanceof TypeError
          ? reply.code(400).send({ code: "INVALID_REQUEST" })
          : unavailable(reply);
      }
    },
  );
}

interface EditBody {
  readonly adminReason: string;
  readonly aliases: readonly string[];
  readonly canonicalCode: string;
  readonly commandId: string;
  readonly description: string | null;
  readonly expectedReleaseVersion: number;
  readonly kind: AdminTaxonomyKind;
  readonly name: string;
  readonly primaryProfessionCode: string | null;
  readonly professionCodes: readonly string[];
  readonly replacedByCode: string | null;
  readonly state: AdminTaxonomyState;
}

function rateLimitConfig(dependencies: AdminTaxonomyCatalogRouteDependencies) {
  return {
    rateLimit: {
      max: Math.min(10, dependencies.rateLimit.max),
      timeWindow: dependencies.rateLimit.timeWindowMs,
    },
  };
}

async function authorizedActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminTaxonomyCatalogRouteDependencies,
): Promise<string | null> {
  const identity = await dependencies.guard.evaluate(request);
  if (identity.status !== "ACTIVE") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return null;
  }
  const decision = await dependencies.adminAccess.authorize({
    capability: "admin.taxonomy.manage",
    requireRecentMfa: true,
    sessionId: request.session.sessionId,
    userId: identity.user.id,
  });
  if (
    decision.status !== "AUTHORIZED" ||
    !decision.actor.capabilities.has("admin.taxonomy.manage")
  ) {
    await denied(reply);
    return null;
  }
  return decision.actor.userId;
}

async function stillAuthorized(
  request: FastifyRequest,
  userId: string,
  dependencies: AdminTaxonomyCatalogRouteDependencies,
): Promise<boolean> {
  const decision = await dependencies.adminAccess.authorize({
    capability: "admin.taxonomy.manage",
    requireRecentMfa: true,
    sessionId: request.session.sessionId,
    userId: userId as UserId,
  });
  return (
    decision.status === "AUTHORIZED" &&
    decision.actor.userId === userId &&
    decision.actor.capabilities.has("admin.taxonomy.manage")
  );
}

function normalizeOptionalQuery(value: string | undefined): string | null {
  const normalized = value?.normalize("NFC").trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

const rejectQuery: preValidationHookHandler = (request, reply, done) => {
  if (Object.keys(request.query as object).length > 0) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
};

function exactBody(keys: readonly string[]): preValidationHookHandler {
  const expected = [...keys].sort();
  return (request, reply, done) => {
    const value = request.body;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== expected.join("|")
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}

function noStore(_request: FastifyRequest, reply: FastifyReply) {
  void reply.header("cache-control", "no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  return Promise.resolve();
}
function denied(reply: FastifyReply) {
  return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
}
function notFound(reply: FastifyReply) {
  return reply.code(404).send({ code: "NOT_FOUND" });
}
function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ code: "ADMIN_TAXONOMY_UNAVAILABLE" });
}

const uuid = { format: "uuid", type: "string" } as const;
const taxonomyCode = {
  maxLength: 84,
  pattern: "^(?:PROF|SERV):[A-Z][A-Z0-9_]{1,62}$",
  type: "string",
} as const;
const emptyQuerySchema = {
  additionalProperties: false,
  type: "object",
} as const;
const catalogParamsSchema = {
  additionalProperties: false,
  properties: { taxonomyCode },
  required: ["taxonomyCode"],
  type: "object",
} as const;
const kind = { enum: ["PROFESSION", "SERVICE"], type: "string" } as const;
const state = { enum: ["ACTIVE", "DEPRECATED"], type: "string" } as const;
const catalogQuerySchema = {
  additionalProperties: false,
  properties: {
    kind,
    limit: { maximum: 300, minimum: 1, type: "integer" },
    query: { maxLength: 100, type: "string" },
    state,
  },
  type: "object",
} as const;
const similarQuerySchema = {
  additionalProperties: false,
  properties: {
    kind,
    limit: { maximum: 20, minimum: 1, type: "integer" },
    query: { maxLength: 100, minLength: 2, type: "string" },
  },
  required: ["query"],
  type: "object",
} as const;
const aliases = {
  items: { maxLength: 100, minLength: 2, type: "string" },
  maxItems: 40,
  type: "array",
  uniqueItems: true,
} as const;
const professionCodes = {
  items: {
    pattern: "^PROF:[A-Z0-9][A-Z0-9_]{1,62}$",
    type: "string",
  },
  maxItems: 8,
  type: "array",
  uniqueItems: true,
} as const;
const description = {
  anyOf: [{ maxLength: 500, minLength: 4, type: "string" }, { type: "null" }],
} as const;
const editKeys = [
  "adminReason",
  "aliases",
  "canonicalCode",
  "commandId",
  "description",
  "expectedReleaseVersion",
  "kind",
  "name",
  "primaryProfessionCode",
  "professionCodes",
  "replacedByCode",
  "state",
];
const editSchema = {
  additionalProperties: false,
  properties: {
    adminReason: { maxLength: 500, minLength: 8, type: "string" },
    aliases,
    canonicalCode: taxonomyCode,
    commandId: uuid,
    description,
    expectedReleaseVersion: { minimum: 1, type: "integer" },
    kind,
    name: { maxLength: 100, minLength: 2, type: "string" },
    primaryProfessionCode: {
      anyOf: [
        {
          pattern: "^PROF:[A-Z0-9][A-Z0-9_]{1,62}$",
          type: "string",
        },
        { type: "null" },
      ],
    },
    professionCodes,
    replacedByCode: { anyOf: [taxonomyCode, { type: "null" }] },
    state,
  },
  required: editKeys,
  type: "object",
} as const;
