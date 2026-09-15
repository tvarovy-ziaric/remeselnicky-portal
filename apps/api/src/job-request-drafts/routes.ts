import {
  JobRequestContentValidationError,
  JobRequestDraftIdempotencyError,
  JobRequestIdempotencyError,
  normalizeJobRequestContentSection,
  normalizeJobRequestDraftSection,
  type CustomerProfileService,
  type JobRequestDraftPersistence,
  type JobRequestDraftService,
  type JobRequestId,
  type JobRequestService,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_REQUEST_DRAFT_PATHS = Object.freeze({
  activate: "/v1/me/job-request-drafts/:jobRequestId/activate",
  autosave: "/v1/me/job-request-drafts/:jobRequestId/sections",
  collection: "/v1/me/job-request-drafts",
  recover: "/v1/me/job-request-drafts/:jobRequestId",
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

export interface JobRequestDraftRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly customerProfiles: CustomerProfileService;
  readonly draftPersistence: Pick<
    JobRequestDraftPersistence,
    "createDraftWithInitialSectionOwned"
  >;
  readonly drafts: JobRequestDraftService;
  readonly guard: Guard;
  readonly requests: JobRequestService;
}

export function registerJobRequestDraftRoutes(
  app: FastifyInstance,
  dependencies: JobRequestDraftRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/v1/me/job-request-drafts")) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.get(JOB_REQUEST_DRAFT_PATHS.collection, async (request, reply) => {
    const actor = await requireActiveActor(request, reply, dependencies.guard);
    if (actor === undefined) return;
    const result = await dependencies.drafts.listRecent(actor);
    if (result.status === "ACCOUNT_NOT_ACTIVE") {
      return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    }
    return reply.send({
      drafts: result.drafts.map((draft) => ({
        changedAt: draft.changedAt.toISOString(),
        createdAt: draft.createdAt.toISOString(),
        id: draft.id,
        revision: draft.revision,
        sectionCount: draft.sectionCount,
      })),
    });
  });

  app.get<{ Params: { jobRequestId: string } }>(
    JOB_REQUEST_DRAFT_PATHS.recover,
    { schema: { params: requestParamsSchema } },
    async (request, reply) => {
      const actor = await requireActiveActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actor === undefined) return;
      const result = await dependencies.drafts.recover({
        actorUserId: actor,
        jobRequestId: request.params.jobRequestId as JobRequestId,
      });
      if (result.status !== "OK") {
        return result.status === "ACCOUNT_NOT_ACTIVE"
          ? reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" })
          : reply.code(404).send({ code: "NOT_FOUND" });
      }
      return reply.send({
        draft: {
          changedAt: result.draft.changedAt.toISOString(),
          createdAt: result.draft.createdAt.toISOString(),
          id: result.draft.id,
          revision: result.draft.revision,
          sections: result.draft.sections.map((section) => ({
            key: section.key,
            payload: section.payload,
            savedAt: section.savedAt.toISOString(),
            schemaVersion: section.schemaVersion,
          })),
        },
      });
    },
  );

  const writeOptions = {
    onRequest: dependencies.csrfProtection,
  } as const;
  app.post<{ Body: InitialSectionBody }>(
    JOB_REQUEST_DRAFT_PATHS.collection,
    {
      ...writeOptions,
      bodyLimit: 40 * 1024,
      schema: { body: initialBodySchema },
    },
    async (request, reply) => {
      const actor = await requireActiveActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actor === undefined) return;
      try {
        const section = normalizeJobRequestDraftSection(
          normalizeJobRequestContentSection(request.body.section),
        );
        const customer =
          await dependencies.customerProfiles.ensureForCustomerUse(actor);
        const result =
          await dependencies.draftPersistence.createDraftWithInitialSectionOwned(
            {
              actorUserId: actor,
              commandId: request.body.commandId,
              customerProfileId: customer.profile.id,
              section,
            },
          );
        return sendDraftWriteResult(reply, result, 201);
      } catch (error: unknown) {
        return sendCommandError(reply, error);
      }
    },
  );

  app.post<{ Body: AutosaveBody; Params: { jobRequestId: string } }>(
    JOB_REQUEST_DRAFT_PATHS.autosave,
    {
      ...writeOptions,
      bodyLimit: 40 * 1024,
      schema: { body: autosaveBodySchema, params: requestParamsSchema },
    },
    async (request, reply) => {
      const actor = await requireActiveActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actor === undefined) return;
      try {
        const section = normalizeJobRequestDraftSection(
          normalizeJobRequestContentSection(request.body.section),
        );
        const result = await dependencies.drafts.autosave({
          actorUserId: actor,
          commandId: request.body.commandId,
          expectedRevision: request.body.expectedRevision,
          jobRequestId: request.params.jobRequestId as JobRequestId,
          section,
        });
        return sendDraftWriteResult(reply, result, 200);
      } catch (error: unknown) {
        return sendCommandError(reply, error);
      }
    },
  );

  app.post<{ Body: CommandBody; Params: { jobRequestId: string } }>(
    JOB_REQUEST_DRAFT_PATHS.activate,
    {
      ...writeOptions,
      schema: { body: commandBodySchema, params: requestParamsSchema },
    },
    async (request, reply) => {
      const actor = await requireActiveActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actor === undefined) return;
      try {
        const result = await dependencies.requests.activate({
          actorUserId: actor,
          commandId: request.body.commandId,
          expectedRevision: request.body.expectedRevision,
          jobRequestId: request.params.jobRequestId as JobRequestId,
        });
        if ("jobRequest" in result) {
          return reply.send({
            activatedAt: result.jobRequest.activatedAt?.toISOString() ?? null,
            id: result.jobRequest.id,
            revision: result.jobRequest.revision,
            status: result.status,
          });
        }
        if (result.status === "NOT_READY") {
          return reply.code(422).send({
            code: "NOT_READY",
            missingRequirements: result.missingRequirements ?? [],
          });
        }
        return sendDomainDenial(reply, result.status);
      } catch (error: unknown) {
        return sendCommandError(reply, error);
      }
    },
  );
}

interface SectionInput {
  readonly key: string;
  readonly payload: unknown;
  readonly schemaVersion: number;
}

interface InitialSectionBody {
  readonly commandId: string;
  readonly section: SectionInput;
}

interface CommandBody {
  readonly commandId: string;
  readonly expectedRevision: number;
}

interface AutosaveBody extends CommandBody {
  readonly section: SectionInput;
}

function sendDraftWriteResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<JobRequestDraftService["autosave"]>>,
  appliedStatusCode: 200 | 201,
) {
  if ("jobRequestId" in result) {
    return reply.code(appliedStatusCode).send({
      id: result.jobRequestId,
      revision: result.revision,
      savedAt: result.savedAt.toISOString(),
      status: result.status,
    });
  }
  return sendDomainDenial(reply, result.status, result.currentRevision);
}

function sendDomainDenial(
  reply: FastifyReply,
  status: string,
  currentRevision?: number,
) {
  switch (status) {
    case "ACCOUNT_NOT_ACTIVE":
      return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    case "NOT_FOUND":
      return reply.code(404).send({ code: "NOT_FOUND" });
    case "STALE_REVISION":
      return reply.code(409).send({ code: "STALE_REVISION", currentRevision });
    case "INVALID_STATE":
    case "INVALID_TRANSITION":
    case "SECTION_LIMIT_REACHED":
      return reply.code(409).send({ code: status });
    default:
      return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
  }
}

function sendCommandError(reply: FastifyReply, error: unknown) {
  if (
    error instanceof JobRequestContentValidationError ||
    error instanceof TypeError
  ) {
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  }
  if (
    error instanceof JobRequestDraftIdempotencyError ||
    error instanceof JobRequestIdempotencyError
  ) {
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  }
  if (isAccountNotActive(error)) {
    return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
  }
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

async function requireActiveActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request);
  if (result.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return undefined;
  }
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  return result.user.id;
}

function isAccountNotActive(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "CUSTOMER_PROFILE_ACCOUNT_NOT_ACTIVE"
  );
}

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const requestParamsSchema = {
  additionalProperties: false,
  properties: { jobRequestId: uuid },
  required: ["jobRequestId"],
  type: "object",
} as const;
const sectionSchema = {
  additionalProperties: false,
  properties: {
    key: {
      enum: [
        "request.core",
        "request.location",
        "request.timing",
        "request.budget",
        "request.details",
        "request.media",
      ],
    },
    payload: { type: "object" },
    schemaVersion: { const: 1 },
  },
  required: ["key", "payload", "schemaVersion"],
  type: "object",
} as const;
const initialBodySchema = {
  additionalProperties: false,
  properties: { commandId: uuid, section: sectionSchema },
  required: ["commandId", "section"],
  type: "object",
} as const;
const commandBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    expectedRevision: { minimum: 1, type: "integer" },
  },
  required: ["commandId", "expectedRevision"],
  type: "object",
} as const;
const autosaveBodySchema = {
  ...commandBodySchema,
  properties: { ...commandBodySchema.properties, section: sectionSchema },
  required: [...commandBodySchema.required, "section"],
} as const;
