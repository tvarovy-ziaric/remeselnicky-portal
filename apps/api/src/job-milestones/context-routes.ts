import {
  JobMilestoneContextIdempotencyError,
  type createJobMilestoneContextRepository,
  type JobMilestoneComment,
  type JobMilestoneContextPage,
  type JobMilestoneMedia,
  type JobMilestoneProposal,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

type Context = ReturnType<typeof createJobMilestoneContextRepository>;
type Decision = "ACCEPT" | "DECLINE";

export const JOB_MILESTONE_CONTEXT_PATHS = Object.freeze({
  proposals: "/v1/me/jobs/:jobId/milestone-proposals",
  proposal: "/v1/me/jobs/:jobId/milestone-proposals/:proposalId",
  decision: "/v1/me/jobs/:jobId/milestone-proposals/:proposalId/decision",
  comments: "/v1/me/jobs/:jobId/milestones/:milestoneId/comments",
  media: "/v1/me/jobs/:jobId/milestones/:milestoneId/media",
});

export interface JobMilestoneContextRouteDependencies {
  readonly context: Context;
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

interface PageQuery {
  readonly limit?: number;
  readonly beforeAt?: string;
  readonly beforeId?: string;
}
interface ProposalBody {
  readonly commandId: string;
  readonly targetMilestoneId?: string | null;
  readonly title: string;
  readonly description?: string | null;
  readonly plannedStartOn?: string | null;
  readonly plannedEndOn?: string | null;
}
interface ProposalParams {
  readonly jobId: string;
  readonly proposalId: string;
}
interface MilestoneParams {
  readonly jobId: string;
  readonly milestoneId: string;
}
type Cursor = Readonly<{ createdAt: Date; id: string }>;

export function registerJobMilestoneContextRoutes(
  app: FastifyInstance,
  dependencies: JobMilestoneContextRouteDependencies,
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

  app.get<{ Params: { jobId: string }; Querystring: PageQuery }>(
    JOB_MILESTONE_CONTEXT_PATHS.proposals,
    {
      ...common,
      onRequest: exactQuery(["limit", "beforeAt", "beforeId"]),
      schema: { params: jobParams, querystring: pageQuery },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      const cursor = parseCursor(request.query, reply);
      if (cursor === false) return;
      try {
        const page = await dependencies.context.listProposals({
          actorUserId: actor,
          jobId: request.params.jobId,
          limit: request.query.limit ?? 20,
          ...(cursor === null ? {} : { cursor }),
        });
        return sendPage(reply, page, serializeProposal);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: ProposalParams }>(
    JOB_MILESTONE_CONTEXT_PATHS.proposal,
    {
      ...common,
      onRequest: exactQuery([]),
      schema: { params: proposalParams },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const proposal = await dependencies.context.getProposal({
          actorUserId: actor,
          ...request.params,
        });
        return proposal === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeProposal(proposal));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { jobId: string }; Body: ProposalBody }>(
    JOB_MILESTONE_CONTEXT_PATHS.proposals,
    {
      ...command,
      preValidation: exactBody(
        ["commandId", "title"],
        ["targetMilestoneId", "description", "plannedStartOn", "plannedEndOn"],
      ),
      schema: { params: jobParams, body: proposalBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      if (!validRange(request.body.plannedStartOn, request.body.plannedEndOn))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        return sendCommand(
          reply,
          await dependencies.context.createProposal({
            actorUserId: actor,
            jobId: request.params.jobId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: ProposalParams;
    Body: { commandId: string; decision: Decision };
  }>(
    JOB_MILESTONE_CONTEXT_PATHS.decision,
    {
      ...command,
      preValidation: exactBody(["commandId", "decision"]),
      schema: { params: proposalParams, body: decisionBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.context.decideProposal({
            actorUserId: actor,
            ...request.params,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: MilestoneParams; Querystring: PageQuery }>(
    JOB_MILESTONE_CONTEXT_PATHS.comments,
    {
      ...common,
      onRequest: exactQuery(["limit", "beforeAt", "beforeId"]),
      schema: { params: milestoneParams, querystring: pageQuery },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      const cursor = parseCursor(request.query, reply);
      if (cursor === false) return;
      try {
        const page = await dependencies.context.listComments({
          actorUserId: actor,
          ...request.params,
          limit: request.query.limit ?? 20,
          ...(cursor === null ? {} : { cursor }),
        });
        return sendPage(reply, page, serializeComment);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: MilestoneParams;
    Body: { commandId: string; body: string };
  }>(
    JOB_MILESTONE_CONTEXT_PATHS.comments,
    {
      ...command,
      preValidation: exactBody(["commandId", "body"]),
      schema: { params: milestoneParams, body: commentBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.context.addComment({
            actorUserId: actor,
            ...request.params,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: MilestoneParams; Querystring: PageQuery }>(
    JOB_MILESTONE_CONTEXT_PATHS.media,
    {
      ...common,
      onRequest: exactQuery(["limit", "beforeAt", "beforeId"]),
      schema: { params: milestoneParams, querystring: pageQuery },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      const cursor = parseCursor(request.query, reply);
      if (cursor === false) return;
      try {
        const page = await dependencies.context.listMedia({
          actorUserId: actor,
          ...request.params,
          limit: request.query.limit ?? 20,
          ...(cursor === null ? {} : { cursor }),
        });
        return sendPage(reply, page, serializeMedia);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: MilestoneParams;
    Body: { commandId: string; mediaAssetId: string };
  }>(
    JOB_MILESTONE_CONTEXT_PATHS.media,
    {
      ...command,
      preValidation: exactBody(["commandId", "mediaAssetId"]),
      schema: { params: milestoneParams, body: mediaBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.context.linkMedia({
            actorUserId: actor,
            ...request.params,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobMilestoneContextRouteDependencies,
): Promise<string | null> {
  const result = await dependencies.guard.evaluate(request);
  if (result.status === "ACTIVE") return result.user.id;
  void reply
    .code(result.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: result.status });
  return null;
}
function parseCursor(
  query: PageQuery,
  reply: FastifyReply,
): Cursor | null | false {
  if ((query.beforeAt === undefined) !== (query.beforeId === undefined)) {
    void reply.code(400).send({ code: "INVALID_CURSOR" });
    return false;
  }
  if (query.beforeAt === undefined || query.beforeId === undefined) return null;
  const parsed = new Date(query.beforeAt);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== query.beforeAt
  ) {
    void reply.code(400).send({ code: "INVALID_CURSOR" });
    return false;
  }
  return { createdAt: parsed, id: query.beforeId };
}
function sendPage<T extends { readonly id: string }>(
  reply: FastifyReply,
  page: JobMilestoneContextPage<T> | null,
  serialize: (item: T) => object,
) {
  return page === null
    ? reply.code(404).send({ code: "NOT_FOUND" })
    : reply.send({
        items: page.items.map(serialize),
        nextCursor:
          page.nextCursor === null
            ? null
            : {
                beforeAt: page.nextCursor.createdAt.toISOString(),
                beforeId: page.nextCursor.id,
              },
      });
}
function serializeProposal(item: JobMilestoneProposal) {
  return {
    id: item.id,
    jobId: item.jobId,
    targetMilestoneId: item.targetMilestoneId,
    title: item.title,
    description: item.description,
    plannedStartOn: item.plannedStartOn,
    plannedEndOn: item.plannedEndOn,
    decision: item.decision,
    appliedMilestoneId: item.appliedMilestoneId,
    canDecide: item.canDecide,
    createdAt: item.createdAt.toISOString(),
    decidedAt: item.decidedAt?.toISOString() ?? null,
  };
}
function serializeComment(item: JobMilestoneComment) {
  return { ...item, createdAt: item.createdAt.toISOString() };
}
function serializeMedia(item: JobMilestoneMedia) {
  return {
    ...item,
    uploadedAt: item.uploadedAt.toISOString(),
    capturedAt: item.capturedAt?.toISOString() ?? null,
    linkedAt: item.linkedAt.toISOString(),
  };
}
function sendCommand(
  reply: FastifyReply,
  result: Awaited<ReturnType<Context["createProposal"]>>,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      id: result.id,
      ...(result.appliedMilestoneId === undefined
        ? {}
        : { appliedMilestoneId: result.appliedMilestoneId }),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}
function sendError(reply: FastifyReply, error: unknown) {
  const conflict = error instanceof JobMilestoneContextIdempotencyError;
  return reply
    .code(error instanceof TypeError ? 400 : conflict ? 409 : 503)
    .send({
      code:
        error instanceof TypeError
          ? "INVALID_REQUEST"
          : conflict
            ? "IDEMPOTENCY_CONFLICT"
            : "TEMPORARILY_UNAVAILABLE",
    });
}
function validDay(value: string | null | undefined): boolean {
  if (value == null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
function validRange(
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  return (
    validDay(start) &&
    validDay(end) &&
    (start == null || end == null || start <= end)
  );
}
function exactQuery(allowed: readonly string[]) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const keys = [
      ...new URL(request.raw.url ?? "", "http://localhost").searchParams.keys(),
    ];
    if (
      keys.some((key) => !allowed.includes(key)) ||
      new Set(keys).size !== keys.length
    ) {
      void reply.code(400).send({ code: "INVALID_QUERY" });
      return;
    }
    done();
  };
}
function exactBody(
  required: readonly string[],
  optional: readonly string[] = [],
) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (
      typeof request.body !== "object" ||
      request.body === null ||
      Array.isArray(request.body) ||
      required.some((key) => !Object.hasOwn(request.body as object, key)) ||
      Object.keys(request.body).some(
        (key) => !required.includes(key) && !optional.includes(key),
      )
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}
function privateHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
) {
  void reply.header("cache-control", "private, no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}

const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const day = {
  anyOf: [
    { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    { type: "null" },
  ],
} as const;
const optionalText = (maxLength: number) => ({
  anyOf: [{ type: "string", minLength: 1, maxLength }, { type: "null" }],
});
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
const milestoneParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "milestoneId"],
  properties: { jobId: uuid, milestoneId: uuid },
} as const;
const pageQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 20 },
    beforeAt: {
      type: "string",
      pattern:
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
    },
    beforeId: uuid,
  },
} as const;
const proposalBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "title"],
  properties: {
    commandId: uuid,
    targetMilestoneId: { anyOf: [uuid, { type: "null" }] },
    title: { type: "string", minLength: 1, maxLength: 160 },
    description: optionalText(2000),
    plannedStartOn: day,
    plannedEndOn: day,
  },
} as const;
const decisionBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "decision"],
  properties: {
    commandId: uuid,
    decision: { type: "string", enum: ["ACCEPT", "DECLINE"] },
  },
} as const;
const commentBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "body"],
  properties: {
    commandId: uuid,
    body: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;
const mediaBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "mediaAssetId"],
  properties: {
    commandId: uuid,
    mediaAssetId: uuid,
  },
} as const;
