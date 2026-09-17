import { CompletionProposalIdempotencyError } from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const COMPLETION_PROPOSAL_PATHS = Object.freeze({
  collection: "/v1/me/jobs/:jobId/completion/proposals",
  agree: "/v1/me/jobs/:jobId/completion/proposals/:proposalId/agree",
  disagree: "/v1/me/jobs/:jobId/completion/proposals/:proposalId/disagree",
});

interface Proposal {
  readonly id: string;
  readonly proposalNumber: number;
  readonly proposedAt: Date;
  readonly note: string | null;
  readonly outcome: "PENDING" | "AGREE" | "DISAGREE";
  readonly decidedAt: Date | null;
  readonly disagreementReason: string | null;
}
type ProposalResult =
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly proposalId: string;
      readonly recordedAt: Date;
    }
  | { readonly status: "NOT_FOUND" | "STALE_STATE" | "STALE_PROPOSAL" };

export interface CompletionProposalRouteDependencies {
  readonly proposals: {
    list(input: {
      actorUserId: string;
      jobId: string;
    }): Promise<readonly Proposal[] | null>;
    propose(input: {
      actorUserId: string;
      commandId: string;
      jobId: string;
      note?: string | null;
    }): Promise<ProposalResult>;
    agree(input: {
      actorUserId: string;
      commandId: string;
      jobId: string;
      proposalId: string;
    }): Promise<ProposalResult>;
    disagree(input: {
      actorUserId: string;
      commandId: string;
      jobId: string;
      proposalId: string;
      reason: string;
    }): Promise<ProposalResult>;
  };
  readonly guard: {
    evaluate(
      request: FastifyRequest,
    ): Promise<
      | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
      | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
    >;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerCompletionProposalRoutes(
  app: FastifyInstance,
  dependencies: CompletionProposalRouteDependencies,
): void {
  const common = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onSend: privateHeaders,
  };
  const command = { ...common, onRequest: dependencies.csrfProtection };
  app.get<{ Params: { jobId: string } }>(
    COMPLETION_PROPOSAL_PATHS.collection,
    { ...common, schema: { params: jobParams } },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const proposals = await dependencies.proposals.list({
          actorUserId: actor,
          jobId: request.params.jobId,
        });
        if (proposals === null)
          return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.send({
          proposals: proposals.map((item) => ({
            id: item.id,
            proposalNumber: item.proposalNumber,
            proposedAt: item.proposedAt.toISOString(),
            note: item.note,
            outcome: item.outcome,
            decidedAt: item.decidedAt?.toISOString() ?? null,
            disagreementReason: item.disagreementReason,
          })),
        });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
  app.post<{
    Params: { jobId: string };
    Body: { commandId: string; note?: string | null };
  }>(
    COMPLETION_PROPOSAL_PATHS.collection,
    {
      ...command,
      preValidation: exactBody(["commandId"], ["note"]),
      schema: { params: jobParams, body: proposeBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendResult(
          reply,
          await dependencies.proposals.propose({
            ...request.body,
            actorUserId: actor,
            jobId: request.params.jobId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string; proposalId: string };
    Body: { commandId: string };
  }>(
    COMPLETION_PROPOSAL_PATHS.agree,
    {
      ...command,
      preValidation: exactBody(["commandId"]),
      schema: { params: proposalParams, body: agreeBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendResult(
          reply,
          await dependencies.proposals.agree({
            actorUserId: actor,
            commandId: request.body.commandId,
            jobId: request.params.jobId,
            proposalId: request.params.proposalId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string; proposalId: string };
    Body: { commandId: string; reason: string };
  }>(
    COMPLETION_PROPOSAL_PATHS.disagree,
    {
      ...command,
      preValidation: exactBody(["commandId", "reason"]),
      schema: { params: proposalParams, body: disagreeBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendResult(
          reply,
          await dependencies.proposals.disagree({
            actorUserId: actor,
            commandId: request.body.commandId,
            jobId: request.params.jobId,
            proposalId: request.params.proposalId,
            reason: request.body.reason,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function sendResult(reply: FastifyReply, result: ProposalResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      proposalId: result.proposalId,
      recordedAt: result.recordedAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}
function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (error instanceof CompletionProposalIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}
async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: CompletionProposalRouteDependencies,
): Promise<string | null> {
  const actor = await dependencies.guard.evaluate(request);
  if (actor.status === "ACTIVE") return actor.user.id;
  void reply
    .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: actor.status });
  return null;
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
function exactBody(
  required: readonly string[],
  optional: readonly string[] = [],
) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      required.some((key) => !Object.hasOwn(body, key)) ||
      Object.keys(body).some(
        (key) => !required.includes(key) && !optional.includes(key),
      )
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}
const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const jobParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId"],
  properties: { jobId: uuid },
} as const;
const proposalParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "proposalId"],
  properties: { jobId: uuid, proposalId: uuid },
} as const;
const proposeBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId"],
  properties: {
    commandId: uuid,
    note: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 1000 },
        { type: "null" },
      ],
    },
  },
} as const;
const agreeBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId"],
  properties: { commandId: uuid },
} as const;
const disagreeBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "reason"],
  properties: {
    commandId: uuid,
    reason: { type: "string", minLength: 8, maxLength: 1000 },
  },
} as const;
