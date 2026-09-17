import type { UserId } from "@portal/domain";
import { JobOperationalIdempotencyError } from "@portal/db";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_OPERATION_PATHS = Object.freeze({
  progress: "/v1/me/jobs/:jobId/progress",
  progressDetail: "/v1/me/jobs/:jobId/progress/:updateId",
  acknowledge: "/v1/me/jobs/:jobId/progress/:updateId/acknowledge",
  issues: "/v1/me/jobs/:jobId/issues",
  issueDetail: "/v1/me/jobs/:jobId/issues/:issueId",
  comments: "/v1/me/jobs/:jobId/issues/:issueId/comments",
});

type CommandStatus = "APPLIED" | "DEDUPLICATED";
type CommandResult =
  | {
      readonly status: CommandStatus;
      readonly id: string;
      readonly createdAt: Date;
    }
  | { readonly status: "NOT_FOUND" | "JOB_CLOSED" | "STALE_STATE" };
type AcknowledgmentResult =
  | { readonly status: CommandStatus; readonly acknowledgedAt: Date }
  | { readonly status: "NOT_FOUND" | "JOB_CLOSED" | "STALE_STATE" };
interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}
interface Page<T> {
  readonly items: readonly T[];
  readonly canCreate: boolean;
  readonly nextCursor: Cursor | null;
}
interface OperationMediaItem {
  readonly mediaAssetId: string;
  readonly kind: "PHOTO" | "DOCUMENT";
  readonly source: "WINNING_CONVERSATION";
  readonly sourceMessageId: string;
  readonly uploadedByUserId: string;
  readonly authorRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly uploadedAt: Date;
  readonly capturedAt: Date | null;
  readonly chronologicalAt: Date;
  readonly displayFilename: string | null;
  readonly contentType: string;
  readonly downloadPath: string;
}
interface ProgressItem {
  readonly id: string;
  readonly jobId: string;
  readonly authorDisplayName: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly media: readonly OperationMediaItem[];
}
interface IssueItem {
  readonly id: string;
  readonly jobId: string;
  readonly authorDisplayName: string;
  readonly authorRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly kind: "PROBLEM" | "DELAY" | "WAITING";
  readonly body: string;
  readonly createdAt: Date;
  readonly media: readonly OperationMediaItem[];
}
interface IssueCommentItem {
  readonly id: string;
  readonly authorDisplayName: string;
  readonly authorRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly body: string;
  readonly createdAt: Date;
}

export interface JobOperationRouteDependencies {
  readonly operations: {
    getProgress(input: {
      actorUserId: string;
      jobId: string;
      updateId: string;
    }): Promise<ProgressItem | null>;
    listProgress(input: {
      actorUserId: string;
      jobId: string;
      limit: number;
      cursor?: Cursor;
    }): Promise<Page<ProgressItem> | null>;
    createProgress(input: {
      actorUserId: string;
      jobId: string;
      commandId: string;
      body: string;
      mediaAssetIds?: readonly string[];
    }): Promise<CommandResult>;
    acknowledgeProgress(input: {
      actorUserId: string;
      jobId: string;
      updateId: string;
      commandId: string;
    }): Promise<AcknowledgmentResult>;
    listIssues(input: {
      actorUserId: string;
      jobId: string;
      limit: number;
      cursor?: Cursor;
    }): Promise<Page<IssueItem> | null>;
    getIssue(input: {
      actorUserId: string;
      jobId: string;
      issueId: string;
    }): Promise<IssueItem | null>;
    createIssue(input: {
      actorUserId: string;
      jobId: string;
      commandId: string;
      kind: "PROBLEM" | "DELAY" | "WAITING";
      body: string;
      mediaAssetIds?: readonly string[];
    }): Promise<CommandResult>;
    listIssueComments(input: {
      actorUserId: string;
      jobId: string;
      issueId: string;
      limit: number;
      cursor?: Cursor;
    }): Promise<Page<IssueCommentItem> | null>;
    addIssueComment(input: {
      actorUserId: string;
      jobId: string;
      issueId: string;
      commandId: string;
      body: string;
    }): Promise<CommandResult>;
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

export function registerJobOperationRoutes(
  app: FastifyInstance,
  dependencies: JobOperationRouteDependencies,
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
  app.get<{ Params: { jobId: string }; Querystring: Query }>(
    JOB_OPERATION_PATHS.progress,
    {
      ...common,
      onRequest: rejectUnknownQuery,
      schema: { params: jobParams, querystring: listQuery },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      const cursor = parseCursor(request.query, reply);
      if (cursor === false) return;
      try {
        const page = await dependencies.operations.listProgress({
          actorUserId: actor,
          jobId: request.params.jobId,
          limit: request.query.limit ?? 20,
          ...(cursor === null ? {} : { cursor }),
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializePage(page));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string };
    Body: { commandId: string; body: string; mediaAssetIds?: string[] };
  }>(
    JOB_OPERATION_PATHS.progress,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactBody(["commandId", "body"], ["mediaAssetIds"]),
      schema: { params: jobParams, body: progressBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.operations.createProgress({
            actorUserId: actor,
            jobId: request.params.jobId,
            commandId: request.body.commandId,
            body: request.body.body,
            ...(request.body.mediaAssetIds === undefined
              ? {}
              : { mediaAssetIds: request.body.mediaAssetIds }),
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: { jobId: string; updateId: string } }>(
    JOB_OPERATION_PATHS.progressDetail,
    {
      ...common,
      onRequest: rejectAnyQuery,
      schema: { params: updateParams },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const item = await dependencies.operations.getProgress({
          actorUserId: actor,
          jobId: request.params.jobId,
          updateId: request.params.updateId,
        });
        return item === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeItem(item));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string; updateId: string };
    Body: { commandId: string };
  }>(
    JOB_OPERATION_PATHS.acknowledge,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactBody(["commandId"]),
      schema: { params: updateParams, body: acknowledgeBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendAcknowledgment(
          reply,
          await dependencies.operations.acknowledgeProgress({
            actorUserId: actor,
            jobId: request.params.jobId,
            updateId: request.params.updateId,
            commandId: request.body.commandId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: { jobId: string }; Querystring: Query }>(
    JOB_OPERATION_PATHS.issues,
    {
      ...common,
      onRequest: rejectUnknownQuery,
      schema: { params: jobParams, querystring: listQuery },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      const cursor = parseCursor(request.query, reply);
      if (cursor === false) return;
      try {
        const page = await dependencies.operations.listIssues({
          actorUserId: actor,
          jobId: request.params.jobId,
          limit: request.query.limit ?? 20,
          ...(cursor === null ? {} : { cursor }),
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializePage(page));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string };
    Body: {
      commandId: string;
      kind: IssueItem["kind"];
      body: string;
      mediaAssetIds?: string[];
    };
  }>(
    JOB_OPERATION_PATHS.issues,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactBody(
        ["commandId", "kind", "body"],
        ["mediaAssetIds"],
      ),
      schema: { params: jobParams, body: issueBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.operations.createIssue({
            actorUserId: actor,
            jobId: request.params.jobId,
            commandId: request.body.commandId,
            kind: request.body.kind,
            body: request.body.body,
            ...(request.body.mediaAssetIds === undefined
              ? {}
              : { mediaAssetIds: request.body.mediaAssetIds }),
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: { jobId: string; issueId: string } }>(
    JOB_OPERATION_PATHS.issueDetail,
    {
      ...common,
      onRequest: rejectAnyQuery,
      schema: { params: issueParams },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const item = await dependencies.operations.getIssue({
          actorUserId: actor,
          jobId: request.params.jobId,
          issueId: request.params.issueId,
        });
        return item === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeItem(item));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: { jobId: string; issueId: string }; Querystring: Query }>(
    JOB_OPERATION_PATHS.comments,
    {
      ...common,
      onRequest: rejectUnknownQuery,
      schema: { params: issueParams, querystring: listQuery },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      const cursor = parseCursor(request.query, reply);
      if (cursor === false) return;
      try {
        const page = await dependencies.operations.listIssueComments({
          actorUserId: actor,
          jobId: request.params.jobId,
          issueId: request.params.issueId,
          limit: request.query.limit ?? 20,
          ...(cursor === null ? {} : { cursor }),
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializePage(page));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string; issueId: string };
    Body: { commandId: string; body: string };
  }>(
    JOB_OPERATION_PATHS.comments,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactBody(["commandId", "body"]),
      schema: { params: issueParams, body: commentBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.operations.addIssueComment({
            actorUserId: actor,
            jobId: request.params.jobId,
            issueId: request.params.issueId,
            commandId: request.body.commandId,
            body: request.body.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

interface Query {
  readonly limit?: number;
  readonly beforeAt?: string;
  readonly beforeId?: string;
}
async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobOperationRouteDependencies,
): Promise<string | null> {
  const actor = await dependencies.guard.evaluate(request);
  if (actor.status === "ACTIVE") return actor.user.id;
  void reply
    .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: actor.status });
  return null;
}
function parseCursor(query: Query, reply: FastifyReply): Cursor | null | false {
  if ((query.beforeAt === undefined) !== (query.beforeId === undefined)) {
    void reply.code(400).send({ code: "INVALID_CURSOR" });
    return false;
  }
  if (query.beforeAt === undefined || query.beforeId === undefined) return null;
  const createdAt = new Date(query.beforeAt);
  if (!Number.isFinite(createdAt.getTime())) {
    void reply.code(400).send({ code: "INVALID_CURSOR" });
    return false;
  }
  return { createdAt, id: query.beforeId };
}
function serializePage<T extends { readonly createdAt: Date }>(page: Page<T>) {
  return {
    items: page.items.map(serializeItem),
    canCreate: page.canCreate,
    nextCursor:
      page.nextCursor === null
        ? null
        : {
            createdAt: page.nextCursor.createdAt.toISOString(),
            id: page.nextCursor.id,
          },
  };
}
function serializeItem<T extends { readonly createdAt: Date }>(item: T) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    ...("acknowledgedAt" in item
      ? {
          acknowledgedAt:
            (item.acknowledgedAt as Date | null)?.toISOString() ?? null,
        }
      : {}),
    ...("media" in item
      ? {
          media: (item.media as readonly OperationMediaItem[]).map((media) => ({
            ...media,
            uploadedAt: media.uploadedAt.toISOString(),
            capturedAt: media.capturedAt?.toISOString() ?? null,
            chronologicalAt: media.chronologicalAt.toISOString(),
          })),
        }
      : {}),
  };
}
function sendCommand(reply: FastifyReply, result: CommandResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      id: result.id,
      createdAt: result.createdAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}
function sendAcknowledgment(reply: FastifyReply, result: AcknowledgmentResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(200).send({
      status: result.status,
      acknowledgedAt: result.acknowledgedAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}
function sendError(reply: FastifyReply, error: unknown) {
  return reply
    .code(
      error instanceof TypeError
        ? 400
        : error instanceof JobOperationalIdempotencyError
          ? 409
          : 503,
    )
    .send({
      code:
        error instanceof TypeError
          ? "INVALID_REQUEST"
          : error instanceof JobOperationalIdempotencyError
            ? "IDEMPOTENCY_CONFLICT"
            : "TEMPORARILY_UNAVAILABLE",
    });
}
function rejectUnknownQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  const keys = [
    ...new URL(request.raw.url ?? "", "http://localhost").searchParams.keys(),
  ];
  if (
    keys.some((key) => !["limit", "beforeAt", "beforeId"].includes(key)) ||
    new Set(keys).size !== keys.length
  ) {
    void reply.code(400).send({ code: "INVALID_QUERY" });
    return;
  }
  done();
}
function rejectAnyQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  if (
    new URL(request.raw.url ?? "", "http://localhost").searchParams.size > 0
  ) {
    void reply.code(400).send({ code: "INVALID_QUERY" });
    return;
  }
  done();
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
const jobParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId"],
  properties: { jobId: uuid },
} as const;
const updateParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "updateId"],
  properties: { jobId: uuid, updateId: uuid },
} as const;
const issueParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "issueId"],
  properties: { jobId: uuid, issueId: uuid },
} as const;
const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 50 },
    beforeAt: { type: "string", format: "date-time" },
    beforeId: uuid,
  },
} as const;
const progressBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "body"],
  properties: {
    commandId: uuid,
    body: { type: "string", minLength: 1, maxLength: 2000 },
    mediaAssetIds: {
      type: "array",
      maxItems: 5,
      uniqueItems: true,
      items: uuid,
    },
  },
} as const;
const issueBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "kind", "body"],
  properties: {
    commandId: uuid,
    kind: { type: "string", enum: ["PROBLEM", "DELAY", "WAITING"] },
    body: { type: "string", minLength: 8, maxLength: 2000 },
    mediaAssetIds: {
      type: "array",
      maxItems: 5,
      uniqueItems: true,
      items: uuid,
    },
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
const acknowledgeBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId"],
  properties: { commandId: uuid },
} as const;
