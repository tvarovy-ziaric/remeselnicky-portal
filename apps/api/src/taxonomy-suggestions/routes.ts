import {
  createTaxonomySuggestionService,
  type TaxonomySuggestion,
  type TaxonomySuggestionPersistence,
} from "@portal/taxonomy";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preValidationHookHandler,
} from "fastify";

export const TAXONOMY_SUGGESTION_PATHS = Object.freeze({
  detail: "/v1/me/taxonomy-suggestions/:suggestionId",
  submit: "/v1/me/craftsman-profiles/:profileId/taxonomy-suggestions",
});

interface Guard {
  evaluate(
    request: FastifyRequest,
    scope?: "PUBLISHING",
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: string } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}
interface SuggestionReads {
  findOwned(
    actorUserId: string,
    suggestionId: string,
  ): Promise<TaxonomySuggestion | null>;
}
export interface TaxonomySuggestionRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly persistence: TaxonomySuggestionPersistence & SuggestionReads;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}
interface SubmitBody {
  readonly commandId: string;
  readonly proposedDescription: string;
  readonly proposedName: string;
  readonly suggestedKind: "PROFESSION" | "SERVICE" | null;
  readonly suggestionId: string;
}

export function registerTaxonomySuggestionRoutes(
  app: FastifyInstance,
  dependencies: TaxonomySuggestionRouteDependencies,
): void {
  const service = createTaxonomySuggestionService({
    persistence: dependencies.persistence,
  });
  const config = {
    rateLimit: {
      max: Math.min(dependencies.rateLimit.max, 10),
      timeWindow: dependencies.rateLimit.timeWindowMs,
    },
  };
  app.post<{ Body: SubmitBody; Params: { profileId: string } }>(
    TAXONOMY_SUGGESTION_PATHS.submit,
    {
      config,
      onRequest: dependencies.csrfProtection,
      onSend: privateHeaders,
      preValidation: [rejectQuery, exactSubmitBody],
      schema: {
        body: submitSchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies.guard, true);
      if (actor === null) return;
      try {
        const result = await service.submit({
          actorUserId: actor,
          commandId: request.body.commandId,
          proposedDescription: request.body.proposedDescription,
          proposedName: request.body.proposedName,
          requesterCraftsmanProfileId: request.params.profileId,
          suggestedKind: request.body.suggestedKind,
          suggestionId: request.body.suggestionId,
        });
        if (!("suggestion" in result)) {
          if (result.status === "PROFILE_UNAVAILABLE") return notFound(reply);
          return reply.code(409).send({ code: result.status });
        }
        return reply.code(result.status === "APPLIED" ? 201 : 200).send({
          status: result.status,
          suggestion: serializeOwnerSuggestion(result.suggestion),
        });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );
  app.get<{ Params: { suggestionId: string } }>(
    TAXONOMY_SUGGESTION_PATHS.detail,
    {
      config,
      onSend: privateHeaders,
      preValidation: rejectQuery,
      schema: { params: suggestionParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies.guard);
      if (actor === null) return;
      try {
        const suggestion = await dependencies.persistence.findOwned(
          actor,
          request.params.suggestionId,
        );
        return suggestion === null
          ? notFound(reply)
          : reply.send({ suggestion: serializeOwnerSuggestion(suggestion) });
      } catch {
        return reply.code(503).send({ code: "SUGGESTION_UNAVAILABLE" });
      }
    },
  );
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
  publishing = false,
): Promise<string | null> {
  const result = await guard.evaluate(
    request,
    publishing ? "PUBLISHING" : undefined,
  );
  if (result.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return null;
  }
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return null;
  }
  return result.user.id;
}
function serializeOwnerSuggestion(value: TaxonomySuggestion) {
  return {
    adminDecisionNote: value.adminDecisionNote,
    createdAt: value.createdAt.toISOString(),
    decidedAt: value.decidedAt?.toISOString() ?? null,
    id: value.id,
    proposedDescription: value.proposedDescription,
    proposedName: value.proposedName,
    resolvedTaxonomyCode: value.resolvedTaxonomyCode,
    resolvedTaxonomyLabel: value.resolvedTaxonomyLabel,
    revision: value.revision,
    state: value.state,
    suggestedKind: value.suggestedKind,
  };
}
const exactSubmitBody: preValidationHookHandler = (request, reply, done) => {
  const body = request.body;
  const expected = [
    "commandId",
    "proposedDescription",
    "proposedName",
    "suggestedKind",
    "suggestionId",
  ];
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).sort().join("|") !== expected.join("|")
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
};
const rejectQuery: preValidationHookHandler = (request, reply, done) => {
  if (Object.keys(request.query as object).length !== 0) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
};
function privateHeaders(_request: FastifyRequest, reply: FastifyReply) {
  void reply.header("cache-control", "no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  return Promise.resolve();
}
function notFound(reply: FastifyReply) {
  return reply.code(404).send({ code: "NOT_FOUND" });
}
function commandError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "TAXONOMY_SUGGESTION_IDEMPOTENCY_CONFLICT"
  )
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "SUGGESTION_UNAVAILABLE" });
}
const uuid = { type: "string", format: "uuid" } as const;
const emptyQuerySchema = {
  additionalProperties: false,
  type: "object",
} as const;
const profileParamsSchema = {
  additionalProperties: false,
  properties: { profileId: uuid },
  required: ["profileId"],
  type: "object",
} as const;
const suggestionParamsSchema = {
  additionalProperties: false,
  properties: { suggestionId: uuid },
  required: ["suggestionId"],
  type: "object",
} as const;
const submitSchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    proposedDescription: { minLength: 10, maxLength: 1000, type: "string" },
    proposedName: { minLength: 2, maxLength: 100, type: "string" },
    suggestedKind: {
      anyOf: [
        { enum: ["PROFESSION", "SERVICE"], type: "string" },
        { type: "null" },
      ],
    },
    suggestionId: uuid,
  },
  required: [
    "commandId",
    "proposedDescription",
    "proposedName",
    "suggestedKind",
    "suggestionId",
  ],
  type: "object",
} as const;
