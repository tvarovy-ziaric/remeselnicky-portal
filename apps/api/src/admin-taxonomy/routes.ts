import type { UserId } from "@portal/domain";
import {
  createTaxonomySuggestionService,
  type TaxonomySuggestion,
  type TaxonomySuggestionPersistence,
} from "@portal/taxonomy";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preValidationHookHandler,
} from "fastify";
import {
  registerAdminTaxonomyCatalogRoutes,
  type AdminTaxonomyCatalogRouteDependencies,
} from "./catalog-routes.js";

export const ADMIN_TAXONOMY_PATHS = Object.freeze({
  approve: "/v1/admin/taxonomy-suggestions/:suggestionId/approve",
  detail: "/v1/admin/taxonomy-suggestions/:suggestionId",
  map: "/v1/admin/taxonomy-suggestions/:suggestionId/map",
  queue: "/v1/admin/taxonomy-suggestions/review-queue",
  reject: "/v1/admin/taxonomy-suggestions/:suggestionId/reject",
});

interface AdminReads {
  findForAdmin(suggestionId: string): Promise<TaxonomySuggestion | null>;
  listPending(limit: number): Promise<readonly TaxonomySuggestion[]>;
}
export interface AdminTaxonomyRouteDependencies extends AdminTaxonomyCatalogRouteDependencies {
  readonly persistence: TaxonomySuggestionPersistence & AdminReads;
}

export function registerAdminTaxonomyRoutes(
  app: FastifyInstance,
  dependencies: AdminTaxonomyRouteDependencies,
): void {
  registerAdminTaxonomyCatalogRoutes(app, dependencies);
  const service = createTaxonomySuggestionService({
    persistence: dependencies.persistence,
  });
  const config = {
    rateLimit: {
      max: Math.min(10, dependencies.rateLimit.max),
      timeWindow: dependencies.rateLimit.timeWindowMs,
    },
  };
  app.get<{ Querystring: { limit?: number } }>(
    ADMIN_TAXONOMY_PATHS.queue,
    {
      config,
      onSend: noStore,
      schema: {
        querystring: {
          additionalProperties: false,
          properties: { limit: { minimum: 1, maximum: 100, type: "integer" } },
          type: "object",
        },
      },
    },
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const items = await dependencies.persistence.listPending(
          request.query.limit ?? 20,
        );
        if (!(await stillAuthorized(request, actor, dependencies)))
          return denied(reply);
        return reply.send({ items: items.map(serializeAdminSuggestion) });
      } catch {
        return unavailable(reply);
      }
    },
  );
  app.get<{ Params: { suggestionId: string } }>(
    ADMIN_TAXONOMY_PATHS.detail,
    {
      config,
      onSend: noStore,
      preValidation: rejectQuery,
      schema: { params: suggestionParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const item = await dependencies.persistence.findForAdmin(
          request.params.suggestionId,
        );
        if (!(await stillAuthorized(request, actor, dependencies)))
          return denied(reply);
        return item === null
          ? notFound(reply)
          : reply.send({ suggestion: serializeAdminSuggestion(item) });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.post<{ Body: ApproveBody; Params: { suggestionId: string } }>(
    ADMIN_TAXONOMY_PATHS.approve,
    mutationOptions(dependencies, approveSchema, approveKeys),
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return decisionReply(
          reply,
          await service.decide({
            actorAdminUserId: actor,
            adminDecisionNote: request.body.adminDecisionNote ?? null,
            aliases: request.body.aliases,
            canonicalCode: request.body.canonicalCode,
            canonicalDescription: request.body.canonicalDescription,
            canonicalKind: request.body.canonicalKind,
            canonicalName: request.body.canonicalName,
            commandId: request.body.commandId,
            decision: "APPROVED_AS_NEW",
            expectedRevision: request.body.expectedRevision,
            primaryProfessionCode: request.body.primaryProfessionCode,
            professionCodes: request.body.professionCodes,
            suggestionId: request.params.suggestionId,
          }),
        );
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );
  app.post<{ Body: MapBody; Params: { suggestionId: string } }>(
    ADMIN_TAXONOMY_PATHS.map,
    mutationOptions(dependencies, mapSchema, mapKeys),
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return decisionReply(
          reply,
          await service.decide({
            actorAdminUserId: actor,
            addProposedNameAsAlias: request.body.addProposedNameAsAlias,
            adminDecisionNote: request.body.adminDecisionNote,
            commandId: request.body.commandId,
            decision: "MAPPED_TO_EXISTING",
            expectedRevision: request.body.expectedRevision,
            resolvedKind: request.body.resolvedKind,
            resolvedTaxonomyCode: request.body.resolvedTaxonomyCode,
            suggestionId: request.params.suggestionId,
          }),
        );
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );
  app.post<{ Body: RejectBody; Params: { suggestionId: string } }>(
    ADMIN_TAXONOMY_PATHS.reject,
    mutationOptions(dependencies, rejectSchema, rejectKeys),
    async (request, reply) => {
      const actor = await authorizedActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return decisionReply(
          reply,
          await service.decide({
            actorAdminUserId: actor,
            adminDecisionNote: request.body.adminDecisionNote,
            commandId: request.body.commandId,
            decision: "REJECTED",
            expectedRevision: request.body.expectedRevision,
            suggestionId: request.params.suggestionId,
          }),
        );
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );
}

interface BaseBody {
  commandId: string;
  expectedRevision: number;
}
interface ApproveBody extends BaseBody {
  adminDecisionNote?: string | null;
  aliases: readonly string[];
  canonicalCode: string;
  canonicalDescription: string | null;
  canonicalKind: "PROFESSION" | "SERVICE";
  canonicalName: string;
  primaryProfessionCode: string | null;
  professionCodes: readonly string[];
}
interface MapBody extends BaseBody {
  addProposedNameAsAlias: boolean;
  adminDecisionNote: string;
  resolvedKind: "PROFESSION" | "SERVICE";
  resolvedTaxonomyCode: string;
}
interface RejectBody extends BaseBody {
  adminDecisionNote: string;
}

function mutationOptions(
  dependencies: AdminTaxonomyRouteDependencies,
  body: object,
  keys: readonly string[],
) {
  return {
    config: {
      rateLimit: {
        max: Math.min(10, dependencies.rateLimit.max),
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onRequest: dependencies.csrfProtection,
    onSend: noStore,
    preValidation: [rejectQuery, exactBody(keys)],
    schema: {
      body,
      params: suggestionParamsSchema,
      querystring: emptyQuerySchema,
    },
  };
}
async function authorizedActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminTaxonomyRouteDependencies,
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
  dependencies: AdminTaxonomyRouteDependencies,
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
function decisionReply(
  reply: FastifyReply,
  result: Awaited<
    ReturnType<ReturnType<typeof createTaxonomySuggestionService>["decide"]>
  >,
) {
  if ("suggestion" in result)
    return reply.send({
      status: result.status,
      suggestion: serializeAdminSuggestion(result.suggestion),
    });
  if (result.status === "SUGGESTION_UNAVAILABLE") return notFound(reply);
  return reply.code(409).send({ code: result.status });
}
function serializeAdminSuggestion(value: TaxonomySuggestion) {
  return {
    adminDecisionNote: value.adminDecisionNote,
    createdAt: value.createdAt.toISOString(),
    decidedAt: value.decidedAt?.toISOString() ?? null,
    id: value.id,
    proposedDescription: value.proposedDescription,
    proposedName: value.proposedName,
    requesterCraftsmanProfileId: value.requesterCraftsmanProfileId,
    resolvedTaxonomyCode: value.resolvedTaxonomyCode,
    resolvedTaxonomyLabel: value.resolvedTaxonomyLabel,
    revision: value.revision,
    state: value.state,
    suggestedKind: value.suggestedKind,
  };
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
function commandError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return unavailable(reply);
}
const uuid = { format: "uuid", type: "string" } as const;
const emptyQuerySchema = {
  additionalProperties: false,
  type: "object",
} as const;
const suggestionParamsSchema = {
  additionalProperties: false,
  properties: { suggestionId: uuid },
  required: ["suggestionId"],
  type: "object",
} as const;
const base = {
  commandId: uuid,
  expectedRevision: { minimum: 1, type: "integer" },
} as const;
const kind = { enum: ["PROFESSION", "SERVICE"], type: "string" } as const;
const approveKeys = [
  "adminDecisionNote",
  "aliases",
  "canonicalCode",
  "canonicalDescription",
  "canonicalKind",
  "canonicalName",
  "commandId",
  "expectedRevision",
  "primaryProfessionCode",
  "professionCodes",
];
const mapKeys = [
  "addProposedNameAsAlias",
  "adminDecisionNote",
  "commandId",
  "expectedRevision",
  "resolvedKind",
  "resolvedTaxonomyCode",
];
const rejectKeys = ["adminDecisionNote", "commandId", "expectedRevision"];
const approveSchema = {
  additionalProperties: false,
  properties: {
    ...base,
    adminDecisionNote: {
      anyOf: [
        { maxLength: 500, minLength: 3, type: "string" },
        { type: "null" },
      ],
    },
    aliases: {
      items: { maxLength: 100, minLength: 2, type: "string" },
      maxItems: 40,
      type: "array",
    },
    canonicalCode: { maxLength: 84, type: "string" },
    canonicalDescription: {
      anyOf: [
        { maxLength: 500, minLength: 4, type: "string" },
        { type: "null" },
      ],
    },
    canonicalKind: kind,
    canonicalName: { maxLength: 100, minLength: 2, type: "string" },
    primaryProfessionCode: {
      anyOf: [
        { pattern: "^PROF:[A-Z0-9][A-Z0-9_]{1,62}$", type: "string" },
        { type: "null" },
      ],
    },
    professionCodes: {
      items: { pattern: "^PROF:[A-Z0-9][A-Z0-9_]{1,62}$", type: "string" },
      maxItems: 8,
      type: "array",
      uniqueItems: true,
    },
  },
  required: approveKeys,
  type: "object",
} as const;
const mapSchema = {
  additionalProperties: false,
  properties: {
    ...base,
    addProposedNameAsAlias: { type: "boolean" },
    adminDecisionNote: { maxLength: 500, minLength: 8, type: "string" },
    resolvedKind: kind,
    resolvedTaxonomyCode: { maxLength: 84, type: "string" },
  },
  required: mapKeys,
  type: "object",
} as const;
const rejectSchema = {
  additionalProperties: false,
  properties: {
    ...base,
    adminDecisionNote: { maxLength: 500, minLength: 8, type: "string" },
  },
  required: rejectKeys,
  type: "object",
} as const;
