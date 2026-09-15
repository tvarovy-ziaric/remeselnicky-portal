import {
  JOB_INVITATION_DECLINE_REASONS,
  JobInvitationIdempotencyError,
  type CraftsmanProfileId,
  type JobInvitationCommandResult,
  type JobInvitationDetail,
  type JobInvitationId,
  type JobInvitationListItem,
  type JobInvitationPersistence,
  type JobRequestId,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_INVITATION_PATH =
  "/v1/me/job-requests/:jobRequestId/invitations";
export const JOB_INVITATION_PATHS = Object.freeze({
  close: "/v1/me/invitations/:invitationId/close",
  detail: "/v1/me/invitations/:invitationId",
  list: "/v1/me/invitations",
  respond: "/v1/me/invitations/:invitationId/respond",
} as const);

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobInvitationRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly invitations: Pick<
    JobInvitationPersistence,
    "closeOwned" | "listOwned" | "readOwned" | "respondOwned" | "sendOwned"
  >;
  readonly rateLimit: {
    readonly max: number;
    readonly timeWindowMs: number;
  };
}

export function registerJobInvitationRoutes(
  app: FastifyInstance,
  dependencies: JobInvitationRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (
      request.url.startsWith("/v1/me/invitations") ||
      (request.url.startsWith("/v1/me/job-requests/") &&
        request.url.includes("/invitations"))
    ) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.get<{ Querystring: { readonly limit?: number } }>(
    JOB_INVITATION_PATHS.list,
    { schema: { querystring: listQuerySchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const items = await dependencies.invitations.listOwned({
          actorUserId,
          limit: request.query.limit ?? 50,
        });
        return reply.send({ items: items.map(serializeListItem) });
      } catch (error: unknown) {
        return readError(error, reply);
      }
    },
  );

  app.get<{
    Params: { readonly jobRequestId: string };
    Querystring: { readonly limit?: number };
  }>(
    JOB_INVITATION_PATH,
    { schema: { params: paramsSchema, querystring: listQuerySchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const items = await dependencies.invitations.listOwned({
          actorUserId,
          jobRequestId: request.params.jobRequestId as JobRequestId,
          limit: request.query.limit ?? 50,
        });
        return reply.send({ items: items.map(serializeListItem) });
      } catch (error: unknown) {
        return readError(error, reply);
      }
    },
  );

  app.get<{ Params: { readonly invitationId: string } }>(
    JOB_INVITATION_PATHS.detail,
    { schema: { params: invitationParamsSchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const invitation = await dependencies.invitations.readOwned({
          actorUserId,
          invitationId: request.params.invitationId as JobInvitationId,
        });
        if (invitation === null) {
          return reply.code(404).send({ code: "NOT_FOUND" });
        }
        return reply.send(serializeDetail(invitation));
      } catch (error: unknown) {
        return readError(error, reply);
      }
    },
  );

  app.post<{
    Body: { readonly commandId: string; readonly craftsmanProfileId: string };
    Params: { readonly jobRequestId: string };
  }>(
    JOB_INVITATION_PATH,
    {
      bodyLimit: 4 * 1024,
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
      schema: { body: commandSchema, params: paramsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.invitations.sendOwned({
          actorUserId,
          commandId: request.body.commandId,
          craftsmanProfileId: request.body
            .craftsmanProfileId as CraftsmanProfileId,
          jobRequestId: request.params.jobRequestId as JobRequestId,
        });
        if ("invitation" in result) {
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            id: result.invitation.id,
            revision: result.invitation.revision,
            state: result.invitation.state,
            status: result.status,
          });
        }
        if (result.status === "ALREADY_INVITED") {
          return reply.send({ status: result.status });
        }
        if (result.status === "ACCOUNT_NOT_ELIGIBLE") {
          return reply.code(403).send({ code: result.status });
        }
        if (
          result.status === "NOT_FOUND" ||
          result.status === "TARGET_NOT_ELIGIBLE"
        ) {
          return reply.code(404).send({ code: "NOT_FOUND" });
        }
        if (result.status === "ACTIVE_LIMIT_REACHED") {
          return reply
            .code(409)
            .send({ activeLimit: result.activeLimit, code: result.status });
        }
        return reply.code(409).send({ code: "INVITATION_CONFLICT" });
      } catch (error: unknown) {
        if (error instanceof JobInvitationIdempotencyError) {
          return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
        }
        if (error instanceof TypeError) {
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        }
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  const writeOptions = {
    bodyLimit: 4 * 1024,
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onRequest: dependencies.csrfProtection,
  } as const;

  app.post<{
    Body: {
      readonly action: "DECLINE" | "ENGAGE" | "WITHDRAW";
      readonly commandId: string;
      readonly declineNote?: string | null;
      readonly declineReason?:
        (typeof JOB_INVITATION_DECLINE_REASONS)[number] | null;
      readonly expectedRevision: number;
    };
    Params: { readonly invitationId: string };
  }>(
    JOB_INVITATION_PATHS.respond,
    {
      ...writeOptions,
      schema: {
        body: responseCommandSchema,
        params: invitationParamsSchema,
      },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.invitations.respondOwned({
          action: request.body.action,
          actorUserId,
          commandId: request.body.commandId,
          ...(request.body.declineNote === undefined
            ? {}
            : { declineNote: request.body.declineNote }),
          ...(request.body.declineReason === undefined
            ? {}
            : { declineReason: request.body.declineReason }),
          expectedRevision: request.body.expectedRevision,
          invitationId: request.params.invitationId as JobInvitationId,
        });
        return sendCommandResult(result, reply);
      } catch (error: unknown) {
        return commandError(error, reply);
      }
    },
  );

  app.post<{
    Body: {
      readonly action: "STOP_CONSIDERING" | "WITHDRAW";
      readonly commandId: string;
      readonly expectedRevision: number;
    };
    Params: { readonly invitationId: string };
  }>(
    JOB_INVITATION_PATHS.close,
    {
      ...writeOptions,
      schema: { body: closeCommandSchema, params: invitationParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.invitations.closeOwned({
          action: request.body.action,
          actorUserId,
          commandId: request.body.commandId,
          expectedRevision: request.body.expectedRevision,
          invitationId: request.params.invitationId as JobInvitationId,
        });
        return sendCommandResult(result, reply);
      } catch (error: unknown) {
        return commandError(error, reply);
      }
    },
  );
}

function serializeListItem(item: JobInvitationListItem) {
  return {
    changedAt: item.changedAt.toISOString(),
    counterpartDisplayName: item.counterpartDisplayName,
    expiresAt: item.expiresAt.toISOString(),
    id: item.id,
    jobRequestId: item.jobRequestId,
    perspective: item.perspective,
    requestTitle: item.requestTitle,
    revision: item.revision,
    state: item.state,
  };
}

function serializeDetail(invitation: JobInvitationDetail) {
  return {
    ...serializeListItem(invitation),
    competitionDisclosure: invitation.competitionDisclosure,
    customerTrust: {
      permittedReviewComments: [
        ...invitation.customerTrust.permittedReviewComments,
      ],
      rating: invitation.customerTrust.rating,
      reviewCount: invitation.customerTrust.reviewCount,
    },
    request: {
      approximateDistanceKm: invitation.request.approximateDistanceKm,
      budget: { ...invitation.request.budget },
      description: invitation.request.description,
      details: { ...invitation.request.details },
      documentMediaAssetIds: [...invitation.request.documentMediaAssetIds],
      municipalityCode: invitation.request.municipalityCode,
      photoMediaAssetIds: [...invitation.request.photoMediaAssetIds],
      primaryProfessionCode: invitation.request.primaryProfessionCode,
      relatedProfessionCodes: [...invitation.request.relatedProfessionCodes],
      skillCodes: [...invitation.request.skillCodes],
      specializationCode: invitation.request.specializationCode,
      timing: { ...invitation.request.timing },
      title: invitation.request.title,
    },
    requestContentRevision: invitation.requestContentRevision,
    requestVisibleVersion: invitation.requestVisibleVersion,
  };
}

function sendCommandResult(
  result: JobInvitationCommandResult,
  reply: FastifyReply,
) {
  if ("invitation" in result) {
    return reply.send({
      revision: result.invitation.revision,
      state: result.invitation.state,
      status: result.status,
    });
  }
  if (result.status === "ACCOUNT_NOT_ELIGIBLE") {
    return reply.code(403).send({ code: result.status });
  }
  if (result.status === "NOT_FOUND") {
    return reply.code(404).send({ code: "NOT_FOUND" });
  }
  return reply.code(409).send({
    code: result.status,
    ...("currentRevision" in result
      ? { currentRevision: result.currentRevision }
      : {}),
  });
}

function readError(error: unknown, reply: FastifyReply) {
  if (error instanceof TypeError) {
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  }
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function commandError(error: unknown, reply: FastifyReply) {
  if (error instanceof JobInvitationIdempotencyError) {
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  }
  if (error instanceof TypeError) {
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  }
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request);
  if (result.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: result.status });
    return undefined;
  }
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: result.status });
    return undefined;
  }
  return result.user.id;
}

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const paramsSchema = {
  additionalProperties: false,
  properties: { jobRequestId: uuid },
  required: ["jobRequestId"],
  type: "object",
} as const;
const invitationParamsSchema = {
  additionalProperties: false,
  properties: { invitationId: uuid },
  required: ["invitationId"],
  type: "object",
} as const;
const listQuerySchema = {
  additionalProperties: false,
  properties: { limit: { maximum: 100, minimum: 1, type: "integer" } },
  type: "object",
} as const;
const commandSchema = {
  additionalProperties: false,
  properties: { commandId: uuid, craftsmanProfileId: uuid },
  required: ["commandId", "craftsmanProfileId"],
  type: "object",
} as const;
const responseCommandSchema = {
  additionalProperties: false,
  properties: {
    action: { enum: ["DECLINE", "ENGAGE", "WITHDRAW"], type: "string" },
    commandId: uuid,
    declineNote: {
      anyOf: [
        { maxLength: 500, minLength: 1, type: "string" },
        { type: "null" },
      ],
    },
    declineReason: {
      anyOf: [
        { enum: JOB_INVITATION_DECLINE_REASONS, type: "string" },
        { type: "null" },
      ],
    },
    expectedRevision: { minimum: 1, type: "integer" },
  },
  required: ["action", "commandId", "expectedRevision"],
  type: "object",
} as const;
const closeCommandSchema = {
  additionalProperties: false,
  properties: {
    action: { enum: ["STOP_CONSIDERING", "WITHDRAW"], type: "string" },
    commandId: uuid,
    expectedRevision: { minimum: 1, type: "integer" },
  },
  required: ["action", "commandId", "expectedRevision"],
  type: "object",
} as const;
