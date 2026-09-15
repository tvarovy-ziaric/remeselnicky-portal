import type {
  JobRequestId,
  QuoteComparisonPersistence,
  QuoteComparisonSort,
  UserId,
} from "@portal/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const QUOTE_COMPARISON_PATH =
  "/v1/me/job-requests/:jobRequestId/quote-comparison" as const;

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

export interface QuoteComparisonRouteDependencies {
  readonly comparison: Pick<QuoteComparisonPersistence, "readCurrent">;
  readonly guard: Guard;
}

export function registerQuoteComparisonRoutes(
  app: FastifyInstance,
  dependencies: QuoteComparisonRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.includes("/quote-comparison")) {
      void reply.header("cache-control", "private, no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });
  app.get<{
    Params: { readonly jobRequestId: string };
    Querystring: { readonly sort?: QuoteComparisonSort };
  }>(
    QUOTE_COMPARISON_PATH,
    {
      schema: { params: paramsSchema, querystring: querySchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const comparison = await dependencies.comparison.readCurrent({
          actorUserId,
          jobRequestId: request.params.jobRequestId as JobRequestId,
          ...(request.query.sort === undefined
            ? {}
            : { sort: request.query.sort }),
        });
        return comparison === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(comparison);
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request);
  if (result.status === "ACTIVE") return result.user.id;
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
  } else {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
  }
  return undefined;
}

const paramsSchema = {
  additionalProperties: false,
  properties: { jobRequestId: { format: "uuid", type: "string" } },
  required: ["jobRequestId"],
  type: "object",
} as const;
const querySchema = {
  additionalProperties: false,
  properties: {
    sort: { enum: ["RECEIVED", "LOWEST_COMPARABLE_PRICE"], type: "string" },
  },
  type: "object",
} as const;
