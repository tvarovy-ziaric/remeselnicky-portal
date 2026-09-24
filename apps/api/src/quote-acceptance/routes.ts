import {
  QuoteAcceptanceIdempotencyError,
  type JobRequestId,
  type QuoteAcceptancePersistence,
  type QuoteId,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { SessionAuthorizationScope } from "../auth/guard.js";

export const QUOTE_ACCEPTANCE_PATH =
  "/v1/me/job-requests/:jobRequestId/quotes/:quoteId/accept";

interface Guard {
  evaluate(
    request: FastifyRequest,
    scope?: SessionAuthorizationScope,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface QuoteAcceptanceRouteDependencies {
  readonly acceptance: Pick<QuoteAcceptancePersistence, "accept">;
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerQuoteAcceptanceRoutes(
  app: FastifyInstance,
  dependencies: QuoteAcceptanceRouteDependencies,
): void {
  app.post<{
    Body: {
      commandId: string;
      explicitlyConfirmed: true;
      expectedQuoteStateRevision: number;
      expectedRequestContentRevision: number;
      expectedRequestVisibleVersion: number;
      finalExactAddress?: string;
      quoteRevision: number;
    };
    Params: { jobRequestId: string; quoteId: string };
  }>(
    QUOTE_ACCEPTANCE_PATH,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
      preValidation: rejectUnexpectedFields,
      schema: { body: bodySchema, params: paramsSchema },
    },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      reply.header("x-robots-tag", "noindex, nofollow");
      const actor = await dependencies.guard.evaluate(request, "QUOTING");
      if (actor.status !== "ACTIVE")
        return reply
          .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
          .send({ code: actor.status });
      try {
        const result = await dependencies.acceptance.accept({
          actorUserId: actor.user.id,
          commandId: request.body.commandId,
          explicitlyConfirmed: request.body.explicitlyConfirmed,
          expectedQuoteStateRevision: request.body.expectedQuoteStateRevision,
          expectedRequestContentRevision:
            request.body.expectedRequestContentRevision,
          expectedRequestVisibleVersion:
            request.body.expectedRequestVisibleVersion,
          ...(request.body.finalExactAddress === undefined
            ? {}
            : { finalExactAddress: request.body.finalExactAddress }),
          jobRequestId: request.params.jobRequestId as JobRequestId,
          quoteId: request.params.quoteId as QuoteId,
          quoteRevision: request.body.quoteRevision,
        });
        if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            acceptedAt: result.acceptedAt.toISOString(),
            jobId: result.jobId,
            status: result.status,
          });
        return sendFailure(reply, result.status);
      } catch (error) {
        if (error instanceof QuoteAcceptanceIdempotencyError)
          return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
        if (error instanceof TypeError)
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

function rejectUnexpectedFields(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const body = request.body;
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).some((key) => !bodyFields.has(key))
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}

function sendFailure(reply: FastifyReply, status: string) {
  if (status === "NOT_FOUND") return reply.code(404).send({ code: status });
  if (
    status === "ADDRESS_REQUIRED" ||
    status === "NOT_ACCEPTABLE" ||
    status === "STALE_REVISION"
  )
    return reply.code(409).send({ code: status });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const paramsSchema = {
  additionalProperties: false,
  properties: { jobRequestId: uuid, quoteId: uuid },
  required: ["jobRequestId", "quoteId"],
  type: "object",
} as const;
const bodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    explicitlyConfirmed: { const: true, type: "boolean" },
    expectedQuoteStateRevision: { minimum: 1, type: "integer" },
    expectedRequestContentRevision: { minimum: 1, type: "integer" },
    expectedRequestVisibleVersion: { minimum: 1, type: "integer" },
    finalExactAddress: { minLength: 1, maxLength: 500, type: "string" },
    quoteRevision: { minimum: 1, type: "integer" },
  },
  required: [
    "commandId",
    "explicitlyConfirmed",
    "expectedQuoteStateRevision",
    "expectedRequestContentRevision",
    "expectedRequestVisibleVersion",
    "quoteRevision",
  ],
  type: "object",
} as const;
const bodyFields: ReadonlySet<string> = new Set([
  ...bodySchema.required,
  "finalExactAddress",
]);
