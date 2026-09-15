import {
  JobRequestContentValidationError,
  JobRequestVersionIdempotencyError,
  type JobRequestId,
  type JobRequestVersionService,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_REQUEST_VERSION_PATHS = Object.freeze({
  current: "/v1/me/job-requests/:jobRequestId",
  historical: "/v1/me/job-requests/:jobRequestId/versions/:contentRevision",
  revise: "/v1/me/job-requests/:jobRequestId/sections",
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

export interface JobRequestVersionRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly versions: JobRequestVersionService;
}

export function registerJobRequestVersionRoutes(
  app: FastifyInstance,
  dependencies: JobRequestVersionRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/v1/me/job-requests/")) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.get<{ Params: { jobRequestId: string } }>(
    JOB_REQUEST_VERSION_PATHS.current,
    { schema: { params: requestParamsSchema } },
    async (request, reply) =>
      readVersion(request, reply, dependencies, undefined),
  );
  app.get<{
    Params: { contentRevision: string; jobRequestId: string };
  }>(
    JOB_REQUEST_VERSION_PATHS.historical,
    { schema: { params: historicalParamsSchema } },
    async (request, reply) =>
      readVersion(
        request,
        reply,
        dependencies,
        parseRevision(request.params.contentRevision),
      ),
  );
  app.post<{
    Body: ReviseBody;
    Params: { jobRequestId: string };
  }>(
    JOB_REQUEST_VERSION_PATHS.revise,
    {
      bodyLimit: 40 * 1024,
      onRequest: dependencies.csrfProtection,
      schema: { body: reviseBodySchema, params: requestParamsSchema },
    },
    async (request, reply) => {
      const actor = await requireActiveActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actor === undefined) return;
      try {
        const result = await dependencies.versions.reviseActive({
          actorUserId: actor,
          commandId: request.body.commandId,
          expectedContentRevision: request.body.expectedContentRevision,
          jobRequestId: request.params.jobRequestId as JobRequestId,
          section: request.body.section,
        });
        if ("version" in result) {
          return reply.send(serializeVersion(result.version, result.status));
        }
        if (result.status === "STALE_REVISION") {
          return reply.code(409).send({
            code: "STALE_REVISION",
            currentContentRevision: result.currentContentRevision,
          });
        }
        return result.status === "ACCOUNT_NOT_ACTIVE"
          ? reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" })
          : reply.code(404).send({ code: "NOT_FOUND" });
      } catch (error: unknown) {
        if (
          error instanceof JobRequestContentValidationError ||
          error instanceof TypeError
        ) {
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        }
        if (error instanceof JobRequestVersionIdempotencyError) {
          return reply.code(409).send({ code: error.code });
        }
        throw error;
      }
    },
  );
}

async function readVersion(
  request: FastifyRequest<{ Params: { jobRequestId: string } }>,
  reply: FastifyReply,
  dependencies: JobRequestVersionRouteDependencies,
  contentRevision: number | undefined,
) {
  const actor = await requireActiveActor(request, reply, dependencies.guard);
  if (actor === undefined) return;
  const result = await dependencies.versions.readActive({
    actorUserId: actor,
    ...(contentRevision === undefined ? {} : { contentRevision }),
    jobRequestId: request.params.jobRequestId as JobRequestId,
  });
  if (result.status !== "OK") {
    return result.status === "ACCOUNT_NOT_ACTIVE"
      ? reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" })
      : reply.code(404).send({ code: "NOT_FOUND" });
  }
  return reply.send({
    sections: result.snapshot.sections,
    version: serializeVersion(result.snapshot.version),
  });
}

async function requireActiveActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request);
  if (result.status === "ACTIVE") return result.user.id;
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
  return undefined;
}

function serializeVersion(
  version: {
    readonly categories: readonly string[];
    readonly changedAt: Date;
    readonly contentRevision: number;
    readonly jobRequestId: JobRequestId;
    readonly material: boolean;
    readonly visibleVersion: number;
  },
  status?: string,
) {
  return {
    categories: version.categories,
    changedAt: version.changedAt.toISOString(),
    contentRevision: version.contentRevision,
    jobRequestId: version.jobRequestId,
    material: version.material,
    ...(status === undefined ? {} : { status }),
    visibleVersion: version.visibleVersion,
  };
}

function parseRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError("Invalid content revision.");
  }
  return revision;
}

interface ReviseBody {
  readonly commandId: string;
  readonly expectedContentRevision: number;
  readonly section: {
    readonly key: string;
    readonly payload: unknown;
    readonly schemaVersion: number;
  };
}

const uuid = { format: "uuid", type: "string" } as const;
const requestParamsSchema = {
  additionalProperties: false,
  properties: { jobRequestId: uuid },
  required: ["jobRequestId"],
  type: "object",
} as const;
const historicalParamsSchema = {
  additionalProperties: false,
  properties: {
    contentRevision: { pattern: "^[1-9][0-9]{0,8}$", type: "string" },
    jobRequestId: uuid,
  },
  required: ["jobRequestId", "contentRevision"],
  type: "object",
} as const;
const reviseBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    expectedContentRevision: {
      maximum: 2_147_483_647,
      minimum: 1,
      type: "integer",
    },
    section: {
      additionalProperties: false,
      properties: {
        key: { maxLength: 64, type: "string" },
        payload: { type: "object" },
        schemaVersion: { maximum: 65_535, minimum: 1, type: "integer" },
      },
      required: ["key", "payload", "schemaVersion"],
      type: "object",
    },
  },
  required: ["commandId", "expectedContentRevision", "section"],
  type: "object",
} as const;
