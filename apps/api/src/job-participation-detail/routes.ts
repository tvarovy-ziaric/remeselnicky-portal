import type { JobParticipationDetail } from "@portal/db";
import type { UserId } from "@portal/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const JOB_PARTICIPATION_DETAIL_PATH =
  "/v1/me/job-participations/:participantId" as const;

export interface JobParticipationDetailRouteDependencies {
  readonly detail: {
    getForViewer(input: {
      readonly actorUserId: string;
      readonly participantId: string;
    }): Promise<JobParticipationDetail | null>;
  };
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<
      | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
      | {
          readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
        }
    >;
  };
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobParticipationDetailRoute(
  app: FastifyInstance,
  dependencies: JobParticipationDetailRouteDependencies,
): void {
  app.get<{ Params: { participantId: string } }>(
    JOB_PARTICIPATION_DETAIL_PATH,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: rejectAnyQuery,
      onSend: privateHeaders,
      schema: {
        params: {
          additionalProperties: false,
          properties: {
            participantId: {
              type: "string",
              pattern:
                "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
            },
          },
          required: ["participantId"],
          type: "object",
        },
      },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE")
        return reply
          .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
          .send({ code: actor.status });
      try {
        const result = await dependencies.detail.getForViewer({
          actorUserId: actor.user.id,
          participantId: request.params.participantId,
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

function rejectAnyQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (new URL(request.raw.url ?? "", "http://localhost").search !== "") {
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
