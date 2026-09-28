import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import {
  type CraftsmanProfileId,
  type PortfolioPhotoPhase,
  type PortfolioProject,
  type PortfolioProjectId,
  type PortfolioProjectPersistence,
  type PortfolioProjectPhotoPersistence,
  type PortfolioProjectPhotoSet,
  type UserId,
} from "@portal/domain";
import {
  MEDIA_UPLOAD_LIMITS,
  MediaUploadRejectedError,
  type PortfolioProjectPhotoUploadService,
} from "@portal/media";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preValidationHookHandler,
} from "fastify";

export const CRAFTSMAN_PORTFOLIO_PATHS = Object.freeze({
  projects: "/v1/me/craftsman-profile/:profileId/portfolio-projects",
  project: "/v1/me/craftsman-profile/:profileId/portfolio-projects/:projectId",
  photos:
    "/v1/me/craftsman-profile/:profileId/portfolio-projects/:projectId/photos",
  photoUploads:
    "/v1/me/craftsman-profile/:profileId/portfolio-projects/:projectId/photo-uploads",
} as const);

interface Guard {
  evaluate(
    request: FastifyRequest,
    scope?: "PUBLISHING",
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

export interface CraftsmanPortfolioRouteDependencies {
  readonly context: {
    findOwnedProfileId(actorUserId: UserId): Promise<CraftsmanProfileId | null>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly photos: PortfolioProjectPhotoPersistence;
  readonly projects: PortfolioProjectPersistence;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
  readonly uploads?: PortfolioProjectPhotoUploadService;
}

interface ProfileParams {
  readonly profileId: string;
}

interface ProjectParams extends ProfileParams {
  readonly projectId: string;
}

interface ProjectBody {
  readonly commandId: string;
  readonly contribution: string | null;
  readonly professionIds: readonly string[];
  readonly shortDescription: string;
  readonly title: string;
}

interface CreateProjectBody extends ProjectBody {
  readonly portfolioProjectId: string;
}

interface EditProjectBody extends ProjectBody {
  readonly expectedRevision: number;
}

interface AttachPhotoBody {
  readonly attachmentId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly mediaAssetId: string;
  readonly phase: PortfolioPhotoPhase;
}

export function registerCraftsmanPortfolioRoutes(
  app: FastifyInstance,
  dependencies: CraftsmanPortfolioRouteDependencies,
): void {
  registerImageBodyParsers(app);
  const common = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onSend: privateHeaders,
  } as const;
  const read = {
    ...common,
    preValidation: rejectQuery,
    schema: { querystring: emptyQuerySchema },
  } as const;
  const write = {
    ...common,
    onRequest: dependencies.csrfProtection,
  } as const;

  app.get<{ Params: ProfileParams }>(
    CRAFTSMAN_PORTFOLIO_PATHS.projects,
    {
      ...read,
      schema: { params: profileParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      try {
        const projects = await dependencies.projects.listOwned({
          actorUserId: actor,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
        });
        return reply.send({ projects: projects.map(serializeProject) });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.post<{ Body: CreateProjectBody; Params: ProfileParams }>(
    CRAFTSMAN_PORTFOLIO_PATHS.projects,
    {
      ...write,
      preValidation: [rejectQuery, exactBody(projectCreateKeys)],
      schema: {
        body: createProjectSchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.projects.create({
          actorUserId: actor,
          commandId: request.body.commandId,
          contribution: request.body.contribution,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          districtCode: null,
          durationUnit: null,
          durationValue: null,
          indicativePriceMaxCents: null,
          indicativePriceMinCents: null,
          materialsAndTechnologies: null,
          municipalityCode: null,
          portfolioProjectId: request.body
            .portfolioProjectId as PortfolioProjectId,
          problem: null,
          professionIds: request.body.professionIds as never,
          shortDescription: request.body.shortDescription,
          skillIds: [],
          solution: null,
          specializationIds: [],
          title: request.body.title,
        });
        return sendProjectResult(reply, result, 201);
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.put<{ Body: EditProjectBody; Params: ProjectParams }>(
    CRAFTSMAN_PORTFOLIO_PATHS.project,
    {
      ...write,
      preValidation: [rejectQuery, exactBody(projectEditKeys)],
      schema: {
        body: editProjectSchema,
        params: projectParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.projects.edit({
          actorUserId: actor,
          commandId: request.body.commandId,
          contribution: request.body.contribution,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          districtCode: null,
          durationUnit: null,
          durationValue: null,
          expectedRevision: request.body.expectedRevision,
          indicativePriceMaxCents: null,
          indicativePriceMinCents: null,
          materialsAndTechnologies: null,
          municipalityCode: null,
          portfolioProjectId: request.params.projectId as PortfolioProjectId,
          problem: null,
          professionIds: request.body.professionIds as never,
          shortDescription: request.body.shortDescription,
          skillIds: [],
          solution: null,
          specializationIds: [],
          title: request.body.title,
        });
        return sendProjectResult(reply, result, 200);
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.get<{ Params: ProjectParams }>(
    CRAFTSMAN_PORTFOLIO_PATHS.photos,
    {
      ...read,
      schema: { params: projectParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      try {
        const photoSet = await dependencies.photos.listOwned({
          actorUserId: actor,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          portfolioProjectId: request.params.projectId as PortfolioProjectId,
        });
        return photoSet === null
          ? notFound(reply)
          : reply.send({ photoSet: serializePhotoSet(photoSet) });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.post<{ Body: AttachPhotoBody; Params: ProjectParams }>(
    CRAFTSMAN_PORTFOLIO_PATHS.photos,
    {
      ...write,
      preValidation: [rejectQuery, exactBody(photoAttachKeys)],
      schema: {
        body: attachPhotoSchema,
        params: projectParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.photos.attach({
          actorUserId: actor,
          attachmentId: request.body.attachmentId as never,
          commandId: request.body.commandId,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          expectedRevision: request.body.expectedRevision,
          mediaAssetId: request.body.mediaAssetId,
          phase: request.body.phase,
          portfolioProjectId: request.params.projectId as PortfolioProjectId,
        });
        return sendPhotoResult(reply, result);
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.get<{ Params: ProjectParams }>(
    CRAFTSMAN_PORTFOLIO_PATHS.photoUploads,
    {
      ...read,
      schema: { params: projectParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      if (dependencies.uploads === undefined) return uploadUnavailable(reply);
      try {
        const result = await dependencies.uploads.list({
          actor: createAuthenticatedAuthorizationActor({
            accountState: "ACTIVE",
            id: actor,
          }),
          craftsmanProfileId: request.params.profileId,
          portfolioProjectId: request.params.projectId,
        });
        return result.status === "OK"
          ? reply.send({ uploads: result.uploads })
          : notFound(reply);
      } catch {
        return uploadUnavailable(reply);
      }
    },
  );

  app.post<{
    Body: Buffer;
    Headers: { "x-expected-project-revision"?: string; "x-file-name"?: string };
    Params: ProjectParams;
  }>(
    CRAFTSMAN_PORTFOLIO_PATHS.photoUploads,
    {
      ...write,
      bodyLimit: MEDIA_UPLOAD_LIMITS.imageMaxBytes,
      preValidation: rejectQuery,
      schema: { params: projectParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      if (dependencies.uploads === undefined) return uploadUnavailable(reply);
      const expectedProjectRevision = parsePositiveIntegerHeader(
        request.headers["x-expected-project-revision"],
      );
      if (expectedProjectRevision === null || !Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ code: "INVALID_FILE" });
      }
      try {
        const result = await dependencies.uploads.upload({
          actor: createAuthenticatedAuthorizationActor({
            accountState: "ACTIVE",
            id: actor,
          }),
          body: request.body,
          craftsmanProfileId: request.params.profileId,
          declaredContentType: request.headers["content-type"] ?? "",
          expectedProjectRevision,
          ...(request.headers["x-file-name"] === undefined
            ? {}
            : { originalFilename: request.headers["x-file-name"] }),
          portfolioProjectId: request.params.projectId,
        });
        return result.status === "PROCESSING"
          ? reply.code(202).send(result)
          : notFound(reply);
      } catch (error: unknown) {
        return error instanceof MediaUploadRejectedError
          ? reply.code(400).send({ code: "INVALID_FILE" })
          : uploadUnavailable(reply);
      }
    },
  );
}

function serializeProject(project: PortfolioProject) {
  return {
    contribution: project.contribution,
    craftsmanProfileId: project.craftsmanProfileId,
    createdAt: project.createdAt.toISOString(),
    districtCode: project.districtCode,
    durationUnit: project.durationUnit,
    durationValue: project.durationValue,
    evidenceStatus: project.evidenceStatus,
    id: project.id,
    indicativePriceMaxCents: project.indicativePriceMaxCents,
    indicativePriceMinCents: project.indicativePriceMinCents,
    materialsAndTechnologies: project.materialsAndTechnologies,
    municipalityCode: project.municipalityCode,
    problem: project.problem,
    professionIds: project.professionIds,
    provenanceKind: project.provenanceKind,
    recordState: project.recordState,
    revision: project.revision,
    shortDescription: project.shortDescription,
    skillIds: project.skillIds,
    solution: project.solution,
    specializationIds: project.specializationIds,
    title: project.title,
    updatedAt: project.updatedAt.toISOString(),
  };
}

function serializePhotoSet(photoSet: PortfolioProjectPhotoSet) {
  return {
    craftsmanProfileId: photoSet.craftsmanProfileId,
    photos: photoSet.photos.map((photo) => ({
      attachedAt: photo.attachedAt.toISOString(),
      attachmentId: photo.attachmentId,
      canonicalHeight: photo.canonicalHeight,
      canonicalWidth: photo.canonicalWidth,
      capturedAt: photo.capturedAt?.toISOString() ?? null,
      downloadPath: `/v1/media/${photo.mediaAssetId}/download`,
      mediaAssetId: photo.mediaAssetId,
      order: photo.order,
      phase: photo.phase,
      state: photo.state,
    })),
    portfolioProjectId: photoSet.portfolioProjectId,
    revision: photoSet.revision,
    updatedAt: photoSet.updatedAt.toISOString(),
  };
}

function sendProjectResult(
  reply: FastifyReply,
  result:
    | Awaited<ReturnType<PortfolioProjectPersistence["create"]>>
    | Awaited<ReturnType<PortfolioProjectPersistence["edit"]>>,
  createdCode: 200 | 201,
) {
  if ("project" in result) {
    return reply.code(result.status === "APPLIED" ? createdCode : 200).send({
      project: serializeProject(result.project),
      status: result.status,
    });
  }
  if (result.status === "PROFILE_UNAVAILABLE") return notFound(reply);
  return conflict(reply, result.status);
}

function sendPhotoResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<PortfolioProjectPhotoPersistence["attach"]>>,
) {
  if ("photoSet" in result) {
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      photoSet: serializePhotoSet(result.photoSet),
      status: result.status,
    });
  }
  if (
    result.status === "PROFILE_UNAVAILABLE" ||
    result.status === "PROJECT_UNAVAILABLE" ||
    result.status === "MEDIA_UNAVAILABLE" ||
    result.status === "PHOTO_UNAVAILABLE"
  ) {
    return notFound(reply);
  }
  return conflict(reply, result.status);
}

async function ownedActor(
  request: FastifyRequest<{ Params: ProfileParams }>,
  reply: FastifyReply,
  dependencies: CraftsmanPortfolioRouteDependencies,
  publishing: boolean,
): Promise<UserId | null> {
  const guard = await dependencies.guard.evaluate(
    request,
    publishing ? "PUBLISHING" : undefined,
  );
  if (guard.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return null;
  }
  if (guard.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return null;
  }
  try {
    const owned = await dependencies.context.findOwnedProfileId(guard.user.id);
    if (owned !== request.params.profileId) {
      await notFound(reply);
      return null;
    }
    return guard.user.id;
  } catch {
    await unavailable(reply);
    return null;
  }
}

function commandError(reply: FastifyReply, error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.endsWith("IDEMPOTENCY_CONFLICT")
  ) {
    return conflict(reply, "IDEMPOTENCY_CONFLICT");
  }
  return error instanceof TypeError
    ? reply.code(400).send({ code: "INVALID_REQUEST" })
    : unavailable(reply);
}

const rejectQuery: preValidationHookHandler = (request, reply, done) => {
  if (Object.keys(request.query as object).length > 0) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
};

function exactBody(keys: readonly string[]): preValidationHookHandler {
  const expected = [...keys].sort();
  return (request, reply, done) => {
    const body =
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : null;
    const actual = body === null ? [] : Object.keys(body).sort();
    if (
      body === null ||
      actual.length !== expected.length ||
      !actual.every((key, index) => key === expected[index])
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}

function registerImageBodyParsers(app: FastifyInstance): void {
  for (const contentType of [
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
  ]) {
    if (app.hasContentTypeParser(contentType)) continue;
    app.addContentTypeParser(
      contentType,
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
  }
}

function parsePositiveIntegerHeader(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function privateHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, value?: unknown) => void,
): void {
  void reply.header("cache-control", "no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ code: "NOT_FOUND" });
}
function conflict(reply: FastifyReply, code: string) {
  return reply.code(409).send({ code });
}
function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}
function uploadUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ code: "UPLOAD_UNAVAILABLE" });
}

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const emptyQuerySchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
} as const;
const profileParamsSchema = {
  additionalProperties: false,
  properties: { profileId: uuid },
  required: ["profileId"],
  type: "object",
} as const;
const projectParamsSchema = {
  additionalProperties: false,
  properties: { profileId: uuid, projectId: uuid },
  required: ["profileId", "projectId"],
  type: "object",
} as const;
const nullableContribution = {
  anyOf: [{ maxLength: 600, minLength: 1, type: "string" }, { type: "null" }],
} as const;
const projectProperties = {
  commandId: uuid,
  contribution: nullableContribution,
  professionIds: {
    items: uuid,
    maxItems: 20,
    minItems: 1,
    type: "array",
    uniqueItems: true,
  },
  shortDescription: { maxLength: 600, minLength: 10, type: "string" },
  title: { maxLength: 120, minLength: 2, type: "string" },
} as const;
const projectBaseKeys = [
  "commandId",
  "contribution",
  "professionIds",
  "shortDescription",
  "title",
] as const;
const projectCreateKeys = [...projectBaseKeys, "portfolioProjectId"] as const;
const projectEditKeys = [...projectBaseKeys, "expectedRevision"] as const;
const createProjectSchema = {
  additionalProperties: false,
  properties: { ...projectProperties, portfolioProjectId: uuid },
  required: projectCreateKeys,
  type: "object",
} as const;
const editProjectSchema = {
  additionalProperties: false,
  properties: {
    ...projectProperties,
    expectedRevision: { minimum: 1, type: "integer" },
  },
  required: projectEditKeys,
  type: "object",
} as const;
const photoAttachKeys = [
  "attachmentId",
  "commandId",
  "expectedRevision",
  "mediaAssetId",
  "phase",
] as const;
const attachPhotoSchema = {
  additionalProperties: false,
  properties: {
    attachmentId: uuid,
    commandId: uuid,
    expectedRevision: { minimum: 0, type: "integer" },
    mediaAssetId: uuid,
    phase: {
      enum: ["BEFORE", "PROGRESS", "AFTER", "OTHER"],
      type: "string",
    },
  },
  required: photoAttachKeys,
  type: "object",
} as const;
