import type { JobDocumentationCursor, JobDocumentationPage } from "@portal/db";
import type { UserId } from "@portal/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const JOB_DOCUMENTATION_PATH =
  "/v1/me/jobs/:jobId/documentation" as const;

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobDocumentationRouteDependencies {
  readonly documentation: {
    listForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly category: "ALL" | "PHOTO" | "DOCUMENT";
      readonly cursor?: JobDocumentationCursor;
      readonly limit: number;
    }): Promise<JobDocumentationPage | null>;
  };
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobDocumentationRoutes(
  app: FastifyInstance,
  dependencies: JobDocumentationRouteDependencies,
): void {
  app.get<{
    Params: { jobId: string };
    Querystring: {
      category?: "ALL" | "PHOTO" | "DOCUMENT";
      limit?: number;
      beforeAt?: string;
      beforeId?: string;
    };
  }>(
    JOB_DOCUMENTATION_PATH,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: rejectUnknownQuery,
      onSend: privateHeaders,
      schema: { params: paramsSchema, querystring: querySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE")
        return reply
          .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
          .send({ code: actor.status });
      const { beforeAt, beforeId } = request.query;
      if ((beforeAt === undefined) !== (beforeId === undefined))
        return reply.code(400).send({ code: "INVALID_CURSOR" });
      const date = beforeAt === undefined ? null : new Date(beforeAt);
      if (date !== null && !Number.isFinite(date.getTime()))
        return reply.code(400).send({ code: "INVALID_CURSOR" });
      try {
        const result = await dependencies.documentation.listForPrimaryParty({
          actorUserId: actor.user.id,
          category: request.query.category ?? "ALL",
          ...(date === null
            ? {}
            : { cursor: { chronologicalAt: date, mediaAssetId: beforeId! } }),
          jobId: request.params.jobId,
          limit: request.query.limit ?? 30,
        });
        return result === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(result);
      } catch (error) {
        if (error instanceof TypeError)
          return reply.code(400).send({ code: "INVALID_QUERY" });
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

function rejectUnknownQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const parameters = new URL(request.raw.url ?? "", "http://localhost")
    .searchParams;
  const allowed = new Set(["category", "limit", "beforeAt", "beforeId"]);
  const keys = [...parameters.keys()];
  if (
    keys.some((key) => !allowed.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    void reply.code(400).send({ code: "INVALID_QUERY" });
    return;
  }
  done();
}

function privateHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  void reply.header("cache-control", "private, no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}

const uuidSchema = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const paramsSchema = {
  additionalProperties: false,
  properties: { jobId: uuidSchema },
  required: ["jobId"],
  type: "object",
} as const;
const querySchema = {
  additionalProperties: false,
  properties: {
    beforeAt: { format: "date-time", type: "string" },
    beforeId: uuidSchema,
    category: { enum: ["ALL", "PHOTO", "DOCUMENT"], type: "string" },
    limit: { maximum: 50, minimum: 1, type: "integer" },
  },
  type: "object",
} as const;
