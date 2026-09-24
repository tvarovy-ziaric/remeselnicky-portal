import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import {
  DISPUTE_CATEGORIES,
  DisputeIdempotencyError,
  type DisputeCaseDetail,
  type DisputeCaseSummary,
  type DisputeCategory,
  type DisputeCommandResult,
  type createJobDisputeRepository,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import {
  MEDIA_UPLOAD_LIMITS,
  MediaUploadRejectedError,
  type DisputeEvidenceMediaKind,
  type DisputeEvidenceUploadService,
} from "@portal/media";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_DISPUTE_PATHS = Object.freeze({
  cases: "/v1/me/jobs/:jobId/disputes",
  detail: "/v1/me/jobs/:jobId/disputes/:disputeId",
  statements: "/v1/me/jobs/:jobId/disputes/:disputeId/statements",
  evidence: "/v1/me/jobs/:jobId/disputes/:disputeId/evidence",
  evidenceUpload:
    "/v1/me/jobs/:jobId/disputes/:disputeId/evidence/uploads/:mediaKind",
  evidenceUploadStatus:
    "/v1/me/jobs/:jobId/disputes/:disputeId/evidence/uploads/:mediaAssetId/status",
} as const);

type Persistence = ReturnType<typeof createJobDisputeRepository>;
interface RateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}
export interface JobDisputeRouteDependencies {
  readonly disputes: Pick<
    Persistence,
    | "addEvidence"
    | "addStatement"
    | "getCase"
    | "getEvidenceUploadStatus"
    | "listCases"
    | "openCase"
  >;
  readonly evidenceUploads?: DisputeEvidenceUploadService;
  readonly guard: {
    evaluate(
      request: FastifyRequest,
    ): Promise<
      | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
      | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
    >;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: {
    readonly read: RateLimit;
    readonly write: RateLimit;
  };
}

interface OpenBody {
  readonly commandId: string;
  readonly category: DisputeCategory;
  readonly description: string;
  readonly desiredResolution: string;
}
interface StatementBody {
  readonly commandId: string;
  readonly kind: "STATEMENT" | "ADDENDUM";
  readonly body: string;
}
interface EvidenceBody {
  readonly commandId: string;
  readonly source: "NEW_UPLOAD" | "EXISTING_JOB_EVIDENCE";
  readonly mediaAssetId: string;
  readonly description: string;
}

export function registerJobDisputeRoutes(
  app: FastifyInstance,
  dependencies: JobDisputeRouteDependencies,
): void {
  registerRawMediaParsers(app);
  const read = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.read.max,
        timeWindow: dependencies.rateLimit.read.timeWindowMs,
      },
    },
    onRequest: rejectQuery,
    onSend: privateHeaders,
  };
  const write = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.write.max,
        timeWindow: dependencies.rateLimit.write.timeWindowMs,
      },
    },
    onRequest: [rejectQuery, dependencies.csrfProtection],
    onSend: privateHeaders,
  };

  app.get<{ Params: { jobId: string } }>(
    JOB_DISPUTE_PATHS.cases,
    { ...read, schema: { params: jobParams } },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const cases = await dependencies.disputes.listCases({
          actorUserId,
          jobId: request.params.jobId,
        });
        return cases === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({ items: cases.map(serializeSummary) });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { jobId: string }; Body: OpenBody }>(
    JOB_DISPUTE_PATHS.cases,
    {
      ...write,
      preValidation: exactOpenBody,
      schema: { params: jobParams, body: openBodySchema },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.disputes.openCase({
            actorUserId,
            jobId: request.params.jobId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { jobId: string; disputeId: string } }>(
    JOB_DISPUTE_PATHS.detail,
    { ...read, schema: { params: caseParams } },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const detail = await dependencies.disputes.getCase({
          actorUserId,
          jobId: request.params.jobId,
          disputeId: request.params.disputeId,
        });
        return detail === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeDetail(detail));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { jobId: string; disputeId: string };
    Body: StatementBody;
  }>(
    JOB_DISPUTE_PATHS.statements,
    {
      ...write,
      preValidation: exactStatementBody,
      schema: { params: caseParams, body: statementBodySchema },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.disputes.addStatement({
            actorUserId,
            jobId: request.params.jobId,
            disputeId: request.params.disputeId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { jobId: string; disputeId: string };
    Body: EvidenceBody;
  }>(
    JOB_DISPUTE_PATHS.evidence,
    {
      ...write,
      preValidation: exactEvidenceBody,
      schema: { params: caseParams, body: evidenceBodySchema },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.disputes.addEvidence({
            actorUserId,
            jobId: request.params.jobId,
            disputeId: request.params.disputeId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: {
      jobId: string;
      disputeId: string;
      mediaKind: "documents" | "photos";
    };
    Body: Buffer;
  }>(
    JOB_DISPUTE_PATHS.evidenceUpload,
    {
      ...write,
      bodyLimit: MEDIA_UPLOAD_LIMITS.documentMaxBytes,
      schema: { params: uploadParams },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      if (dependencies.evidenceUploads === undefined)
        return reply.code(503).send({ code: "UPLOAD_UNAVAILABLE" });
      const mediaKind: DisputeEvidenceMediaKind =
        request.params.mediaKind === "photos" ? "IMAGE" : "PDF";
      const maximumBytes =
        mediaKind === "IMAGE"
          ? MEDIA_UPLOAD_LIMITS.imageMaxBytes
          : MEDIA_UPLOAD_LIMITS.documentMaxBytes;
      const contentType = request.headers["content-type"] ?? "";
      if (
        !Buffer.isBuffer(request.body) ||
        request.body.byteLength < 1 ||
        !contentTypeAllowed(mediaKind, contentType)
      )
        return reply.code(400).send({ code: "INVALID_FILE" });
      if (request.body.byteLength > maximumBytes)
        return reply.code(413).send({ code: "FILE_TOO_LARGE" });
      try {
        const result = await dependencies.evidenceUploads.upload({
          actor: createAuthenticatedAuthorizationActor({
            accountState: "ACTIVE",
            id: actorUserId,
          }),
          body: request.body,
          jobId: request.params.jobId,
          disputeId: request.params.disputeId,
          declaredContentType: contentType,
          mediaKind,
        });
        return result.status === "PROCESSING"
          ? reply.code(202).send(result)
          : reply.code(404).send({ code: "UPLOAD_UNAVAILABLE" });
      } catch (error) {
        if (error instanceof MediaUploadRejectedError)
          return reply.code(error.code === "FILE_TOO_LARGE" ? 413 : 400).send({
            code:
              error.code === "FILE_TOO_LARGE"
                ? "FILE_TOO_LARGE"
                : "INVALID_FILE",
          });
        return reply.code(503).send({ code: "UPLOAD_UNAVAILABLE" });
      }
    },
  );

  app.get<{
    Params: { jobId: string; disputeId: string; mediaAssetId: string };
  }>(
    JOB_DISPUTE_PATHS.evidenceUploadStatus,
    { ...read, schema: { params: uploadStatusParams } },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const status = await dependencies.disputes.getEvidenceUploadStatus({
          actorUserId,
          jobId: request.params.jobId,
          disputeId: request.params.disputeId,
          mediaAssetId: request.params.mediaAssetId,
        });
        return status === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(status);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function serializeSummary(item: DisputeCaseSummary) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    stateChangedAt: item.stateChangedAt.toISOString(),
  };
}
function serializeDetail(item: DisputeCaseDetail) {
  return {
    ...serializeSummary(item),
    statements: item.statements.map((statement) => ({
      ...statement,
      createdAt: statement.createdAt.toISOString(),
    })),
    evidence: item.evidence.map((evidence) => ({
      ...evidence,
      createdAt: evidence.createdAt.toISOString(),
    })),
    adminRequests: item.adminRequests.map((request) => ({
      ...request,
      replyDeadline: request.replyDeadline?.toISOString() ?? null,
      requestedAt: request.requestedAt.toISOString(),
    })),
    outcome:
      item.outcome === null
        ? null
        : {
            ...item.outcome,
            recordedAt: item.outcome.recordedAt.toISOString(),
          },
    caseTimeline: item.caseTimeline.map((event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
    })),
    commercialBaseline: {
      ...item.commercialBaseline,
      approvedChanges: item.commercialBaseline.approvedChanges.map(
        (change) => ({
          ...change,
          approvedAt: change.approvedAt.toISOString(),
        }),
      ),
    },
    jobTimeline: item.jobTimeline.map((event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
    })),
  };
}

function sendCommand(reply: FastifyReply, result: DisputeCommandResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      ...result,
      occurredAt: result.occurredAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}
function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (error instanceof DisputeIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}
async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobDisputeRouteDependencies,
): Promise<UserId | null> {
  const actor = await dependencies.guard.evaluate(request);
  if (actor.status === "ACTIVE") return actor.user.id;
  void reply
    .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: actor.status });
  return null;
}
function rejectQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  if (Object.keys(request.query as object).length !== 0) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}
function exactOpenBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  if (!validExactBody(request.body, openKeys)) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}
function exactStatementBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  if (!validExactBody(request.body, statementKeys)) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}
function exactEvidenceBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  if (!validExactBody(request.body, evidenceKeys)) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}
function validExactBody(value: unknown, keys: readonly string[]) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
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
function registerRawMediaParsers(app: FastifyInstance): void {
  for (const contentType of [
    "application/pdf",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
  ]) {
    if (!app.hasContentTypeParser(contentType))
      app.addContentTypeParser(
        contentType,
        { parseAs: "buffer" },
        (_request, body, done) => done(null, body),
      );
  }
}
function contentTypeAllowed(
  kind: DisputeEvidenceMediaKind,
  contentType: string,
): boolean {
  const normalized = contentType.toLowerCase().trim();
  return kind === "PDF"
    ? normalized === "application/pdf"
    : ["image/heic", "image/heif", "image/jpeg", "image/png"].includes(
        normalized,
      );
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
const caseParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "disputeId"],
  properties: { jobId: uuid, disputeId: uuid },
} as const;
const uploadParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "disputeId", "mediaKind"],
  properties: {
    jobId: uuid,
    disputeId: uuid,
    mediaKind: { enum: ["documents", "photos"] },
  },
} as const;
const uploadStatusParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "disputeId", "mediaAssetId"],
  properties: { jobId: uuid, disputeId: uuid, mediaAssetId: uuid },
} as const;
const openKeys = [
  "category",
  "commandId",
  "description",
  "desiredResolution",
] as const;
const statementKeys = ["body", "commandId", "kind"] as const;
const evidenceKeys = [
  "commandId",
  "description",
  "mediaAssetId",
  "source",
] as const;
const openBodySchema = {
  type: "object",
  additionalProperties: false,
  required: openKeys,
  properties: {
    commandId: uuid,
    category: { enum: DISPUTE_CATEGORIES },
    description: { type: "string", minLength: 10, maxLength: 4000 },
    desiredResolution: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;
const statementBodySchema = {
  type: "object",
  additionalProperties: false,
  required: statementKeys,
  properties: {
    commandId: uuid,
    kind: { enum: ["STATEMENT", "ADDENDUM"] },
    body: { type: "string", minLength: 1, maxLength: 4000 },
  },
} as const;
const evidenceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: evidenceKeys,
  properties: {
    commandId: uuid,
    source: { enum: ["NEW_UPLOAD", "EXISTING_JOB_EVIDENCE"] },
    mediaAssetId: uuid,
    description: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const;
