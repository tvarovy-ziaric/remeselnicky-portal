import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import {
  type CredentialClaim,
  type CredentialClaimId,
  type CredentialClaimPersistence,
  type CredentialEvidenceRequirement,
  type CraftsmanProfessionId,
  type CraftsmanProfileId,
  type UserId,
} from "@portal/domain";
import {
  MEDIA_UPLOAD_LIMITS,
  MediaUploadRejectedError,
  type CredentialEvidenceUploadService,
} from "@portal/media";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preValidationHookHandler,
} from "fastify";

export const CRAFTSMAN_CREDENTIAL_PATHS = Object.freeze({
  credentialTypes: "/v1/me/craftsman-profile/:profileId/credential-types",
  credentials: "/v1/me/craftsman-profile/:profileId/credentials",
  evidence: "/v1/me/craftsman-profile/:profileId/credentials/:claimId/evidence",
  evidenceUploads:
    "/v1/me/craftsman-profile/:profileId/credentials/:claimId/evidence-uploads",
  evidenceUpload:
    "/v1/me/craftsman-profile/:profileId/credentials/:claimId/evidence-uploads/:mediaKind",
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

export interface CredentialTypeReadRepository {
  listActive(): Promise<
    readonly Readonly<{
      code: string;
      evidenceRequirement: CredentialEvidenceRequirement;
    }>[]
  >;
}

export interface CraftsmanCredentialRouteDependencies {
  readonly claims: CredentialClaimPersistence;
  readonly context: {
    findOwnedProfileId(actorUserId: UserId): Promise<CraftsmanProfileId | null>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
  readonly types: CredentialTypeReadRepository;
  readonly uploads?: CredentialEvidenceUploadService;
}

interface ProfileParams {
  readonly profileId: string;
}

interface ClaimParams extends ProfileParams {
  readonly claimId: string;
}

interface UploadParams extends ClaimParams {
  readonly mediaKind: "documents" | "photos";
}

interface CreateClaimBody {
  readonly claimId: string;
  readonly commandId: string;
  readonly craftsmanProfessionId: string;
  readonly credentialTypeCode: string;
  readonly expiresOn: string | null;
}

interface AttachEvidenceBody {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly mediaAssetId: string;
}

export function registerCraftsmanCredentialRoutes(
  app: FastifyInstance,
  dependencies: CraftsmanCredentialRouteDependencies,
): void {
  registerBinaryBodyParsers(app);
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
  } as const;
  const write = {
    ...common,
    onRequest: dependencies.csrfProtection,
  } as const;

  app.get<{ Params: ProfileParams }>(
    CRAFTSMAN_CREDENTIAL_PATHS.credentialTypes,
    {
      ...read,
      schema: { params: profileParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      try {
        const credentialTypes = await dependencies.types.listActive();
        return reply.send({ credentialTypes });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.get<{ Params: ProfileParams }>(
    CRAFTSMAN_CREDENTIAL_PATHS.credentials,
    {
      ...read,
      schema: { params: profileParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      try {
        const credentials = await dependencies.claims.listOwned({
          actorUserId: actor,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
        });
        return reply.send({ credentials: credentials.map(serializeClaim) });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.post<{ Body: CreateClaimBody; Params: ProfileParams }>(
    CRAFTSMAN_CREDENTIAL_PATHS.credentials,
    {
      ...write,
      preValidation: [rejectQuery, exactBody(createClaimKeys)],
      schema: {
        body: createClaimSchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.claims.create({
          actorUserId: actor,
          claimId: request.body.claimId as CredentialClaimId,
          commandId: request.body.commandId,
          craftsmanProfessionId: request.body
            .craftsmanProfessionId as CraftsmanProfessionId,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          credentialTypeCode: request.body.credentialTypeCode,
          expiresOn: request.body.expiresOn,
        });
        if ("claim" in result) {
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            claim: serializeClaim(result.claim),
            status: result.status,
          });
        }
        if (
          result.status === "PROFILE_UNAVAILABLE" ||
          result.status === "PROFESSION_UNAVAILABLE" ||
          result.status === "TYPE_UNAVAILABLE"
        ) {
          return notFound(reply);
        }
        return conflict(reply, result.status);
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.get<{ Params: ClaimParams }>(
    CRAFTSMAN_CREDENTIAL_PATHS.evidenceUploads,
    {
      ...read,
      schema: { params: claimParamsSchema, querystring: emptyQuerySchema },
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
          claimId: request.params.claimId,
          craftsmanProfileId: request.params.profileId,
        });
        return result.status === "OK"
          ? reply.send({ uploads: result.uploads })
          : notFound(reply);
      } catch {
        return uploadUnavailable(reply);
      }
    },
  );

  app.post<{ Body: Buffer; Params: UploadParams }>(
    CRAFTSMAN_CREDENTIAL_PATHS.evidenceUpload,
    {
      ...write,
      bodyLimit: MEDIA_UPLOAD_LIMITS.documentMaxBytes,
      preValidation: rejectQuery,
      schema: { params: uploadParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      if (dependencies.uploads === undefined) return uploadUnavailable(reply);
      const expectedRevision = parsePositiveIntegerHeader(
        request.headers["x-expected-credential-revision"],
      );
      if (expectedRevision === null || !Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ code: "INVALID_FILE" });
      }
      const mediaKind =
        request.params.mediaKind === "documents" ? "DOCUMENT" : "IMAGE";
      try {
        const result = await dependencies.uploads.upload({
          actor: createAuthenticatedAuthorizationActor({
            accountState: "ACTIVE",
            id: actor,
          }),
          body: request.body,
          claimId: request.params.claimId,
          craftsmanProfileId: request.params.profileId,
          declaredContentType: request.headers["content-type"] ?? "",
          expectedRevision,
          mediaKind,
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

  app.post<{ Body: AttachEvidenceBody; Params: ClaimParams }>(
    CRAFTSMAN_CREDENTIAL_PATHS.evidence,
    {
      ...write,
      preValidation: [rejectQuery, exactBody(attachEvidenceKeys)],
      schema: {
        body: attachEvidenceSchema,
        params: claimParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.claims.attachEvidence({
          actorUserId: actor,
          claimId: request.params.claimId as CredentialClaimId,
          commandId: request.body.commandId,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          expectedRevision: request.body.expectedRevision,
          mediaAssetId: request.body.mediaAssetId,
        });
        if ("claim" in result) {
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            claim: serializeClaim(result.claim),
            status: result.status,
          });
        }
        if (
          result.status === "PROFILE_UNAVAILABLE" ||
          result.status === "CLAIM_UNAVAILABLE" ||
          result.status === "EVIDENCE_UNAVAILABLE"
        ) {
          return notFound(reply);
        }
        return conflict(reply, result.status);
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );
}

function serializeClaim(claim: CredentialClaim) {
  return {
    createdAt: claim.createdAt.toISOString(),
    craftsmanProfessionId: claim.craftsmanProfessionId,
    craftsmanProfileId: claim.craftsmanProfileId,
    credentialTypeCode: claim.credentialTypeCode,
    evidence: claim.evidence.map((item) => ({
      attachedAt: item.attachedAt.toISOString(),
      mediaAssetId: item.mediaAssetId,
      mediaKind: item.mediaKind,
    })),
    evidenceRequirement: claim.evidenceRequirement,
    expiresOn: claim.expiresOn,
    id: claim.id,
    reviewReason: claim.reviewReason,
    reviewReasonCategory: claim.reviewReasonCategory,
    reviewedAt: claim.reviewedAt?.toISOString() ?? null,
    revision: claim.revision,
    state: claim.state,
    updatedAt: claim.updatedAt.toISOString(),
  };
}

async function ownedActor(
  request: FastifyRequest<{ Params: ProfileParams }>,
  reply: FastifyReply,
  dependencies: CraftsmanCredentialRouteDependencies,
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

function registerBinaryBodyParsers(app: FastifyInstance): void {
  for (const contentType of [
    "application/pdf",
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
const claimParamsSchema = {
  additionalProperties: false,
  properties: { claimId: uuid, profileId: uuid },
  required: ["profileId", "claimId"],
  type: "object",
} as const;
const uploadParamsSchema = {
  additionalProperties: false,
  properties: {
    claimId: uuid,
    mediaKind: { enum: ["documents", "photos"], type: "string" },
    profileId: uuid,
  },
  required: ["profileId", "claimId", "mediaKind"],
  type: "object",
} as const;
const createClaimKeys = [
  "claimId",
  "commandId",
  "craftsmanProfessionId",
  "credentialTypeCode",
  "expiresOn",
] as const;
const createClaimSchema = {
  additionalProperties: false,
  properties: {
    claimId: uuid,
    commandId: uuid,
    craftsmanProfessionId: uuid,
    credentialTypeCode: {
      maxLength: 64,
      pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
      type: "string",
    },
    expiresOn: {
      anyOf: [{ format: "date", type: "string" }, { type: "null" }],
    },
  },
  required: createClaimKeys,
  type: "object",
} as const;
const attachEvidenceKeys = [
  "commandId",
  "expectedRevision",
  "mediaAssetId",
] as const;
const attachEvidenceSchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    expectedRevision: { minimum: 1, type: "integer" },
    mediaAssetId: uuid,
  },
  required: attachEvidenceKeys,
  type: "object",
} as const;
