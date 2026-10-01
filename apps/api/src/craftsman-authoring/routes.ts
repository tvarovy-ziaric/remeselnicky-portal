import {
  ALPHA_EXTRA_SERVICE_AREA_UI_LIMIT,
  createCraftsmanProfileService,
  type CraftsmanProfile,
  type CraftsmanProfileId,
  type CraftsmanProfilePersistence,
  type CraftsmanProfession,
  type CraftsmanProfessionId,
  type CraftsmanProfessionPersistence,
  type CraftsmanService,
  type CraftsmanServiceId,
  type CraftsmanServicePersistence,
  type CraftsmanPublicationPersistence,
  type CraftsmanPublicationState,
  type CraftsmanServiceArea,
  type CraftsmanServiceAreaPersistence,
  type MunicipalityCode,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preValidationHookHandler,
} from "fastify";

export const CRAFTSMAN_AUTHORING_PATHS = Object.freeze({
  profile: "/v1/me/craftsman-profile",
  profileById: "/v1/me/craftsman-profile/:profileId",
  professions: "/v1/me/craftsman-profile/:profileId/professions",
  services: "/v1/me/craftsman-profile/:profileId/services",
  serviceDeactivate:
    "/v1/me/craftsman-profile/:profileId/services/:craftsmanServiceId/deactivate",
  professionLevel:
    "/v1/me/craftsman-profile/:profileId/professions/:craftsmanProfessionId/level",
  professionDeactivate:
    "/v1/me/craftsman-profile/:profileId/professions/:craftsmanProfessionId/deactivate",
  serviceArea: "/v1/me/craftsman-profile/:profileId/service-area",
  publication: "/v1/me/craftsman-profile/:profileId/publication",
  publicationSubmit: "/v1/me/craftsman-profile/:profileId/publication/submit",
  publicationVisibility:
    "/v1/me/craftsman-profile/:profileId/publication/visibility",
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

export interface CraftsmanAuthoringContext {
  findOwnedProfileId(actorUserId: UserId): Promise<CraftsmanProfileId | null>;
  resolveCurrentProfession(professionCode: string): Promise<{
    readonly professionCode: string;
    readonly taxonomyReleaseId: string;
  } | null>;
  resolveCurrentService(serviceCode: string): Promise<{
    readonly professionCodes: readonly string[];
    readonly serviceCode: string;
    readonly taxonomyReleaseId: string;
  } | null>;
}

export interface CraftsmanAuthoringRouteDependencies {
  readonly context: CraftsmanAuthoringContext;
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly profiles: CraftsmanProfilePersistence;
  readonly professions: CraftsmanProfessionPersistence;
  readonly services: CraftsmanServicePersistence;
  readonly publication: CraftsmanPublicationPersistence;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
  readonly serviceAreas: CraftsmanServiceAreaPersistence;
}

interface ProfileParams {
  readonly profileId: string;
}

interface ProfessionParams extends ProfileParams {
  readonly craftsmanProfessionId: string;
}
interface ServiceParams extends ProfileParams {
  readonly craftsmanServiceId: string;
}

interface CreateIndividualBody {
  readonly about?: string | null;
  readonly nickname?: string | null;
  readonly profileType: "INDIVIDUAL";
  readonly realFirstName?: string | null;
  readonly realLastName?: string | null;
}

interface CreateCompanyBody {
  readonly about?: string | null;
  readonly companyRegistrationNumber?: string | null;
  readonly officialCompanyName?: string | null;
  readonly profileType: "COMPANY";
}

type CreateProfileBody = CreateIndividualBody | CreateCompanyBody;

interface ReplaceIndividualBody {
  readonly about: string | null;
  readonly expectedRevision: number;
  readonly nickname: string | null;
  readonly profileType: "INDIVIDUAL";
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
}

interface ReplaceCompanyBody {
  readonly about: string | null;
  readonly companyRegistrationNumber: string | null;
  readonly expectedRevision: number;
  readonly officialCompanyName: string | null;
  readonly profileType: "COMPANY";
}

type ReplaceProfileBody = ReplaceIndividualBody | ReplaceCompanyBody;

interface AssignProfessionBody {
  readonly commandId: string;
  readonly craftsmanProfessionId: string;
  readonly declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER";
  readonly professionCode: string;
}
interface AddServiceBody {
  readonly commandId: string;
  readonly craftsmanProfessionIds: readonly string[];
  readonly craftsmanServiceId: string;
  readonly serviceCode: string;
}

interface ServiceAreaBody {
  readonly baseMunicipalityCode: string | null;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly extraMunicipalityCodes: readonly string[];
  readonly maximumRadiusKm: number | null;
  readonly normalRadiusKm: number | null;
  readonly travelFeePolicy: string | null;
  readonly travelFeeThresholdKm: number | null;
}

export function registerCraftsmanAuthoringRoutes(
  app: FastifyInstance,
  dependencies: CraftsmanAuthoringRouteDependencies,
): void {
  const profileService = createCraftsmanProfileService(dependencies.profiles);
  const common = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onSend: privateHeaders,
    preValidation: rejectQuery,
  } as const;
  const read = { ...common, schema: { querystring: emptyQuerySchema } };
  const write = {
    ...common,
    onRequest: dependencies.csrfProtection,
  } as const;

  app.get(CRAFTSMAN_AUTHORING_PATHS.profile, read, async (request, reply) => {
    const actor = await activeActor(request, reply, dependencies.guard);
    if (actor === null) return;
    try {
      const aggregate = await loadAggregate(actor, dependencies);
      if (aggregate === null) return notFound(reply);
      return reply.send(aggregate);
    } catch {
      return unavailable(reply);
    }
  });

  app.post<{ Body: CreateProfileBody }>(
    CRAFTSMAN_AUTHORING_PATHS.profile,
    {
      ...write,
      preValidation: [rejectQuery, exactCreateProfileBody],
      schema: { body: createProfileSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies.guard, true);
      if (actor === null) return;
      try {
        const result = await profileService.createPrivateDraft({
          actorUserId: actor,
          ...request.body,
        });
        if (!("profile" in result)) {
          return result.status === "OWNER_NOT_ACTIVE"
            ? inactive(reply)
            : conflict(reply, "PROFILE_ALREADY_EXISTS");
        }
        return reply
          .code(result.status === "CREATED" ? 201 : 200)
          .send({ profile: serializeProfile(result.profile) });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.put<{ Body: ReplaceProfileBody; Params: ProfileParams }>(
    CRAFTSMAN_AUTHORING_PATHS.profileById,
    {
      ...write,
      preValidation: [rejectQuery, exactReplaceProfileBody],
      schema: {
        body: replaceProfileSchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await profileService.replacePrivateDraft({
          actorUserId: actor,
          profileId: request.params.profileId as CraftsmanProfileId,
          ...request.body,
        });
        if (!("profile" in result)) {
          if (result.status === "NOT_FOUND") return notFound(reply);
          if (result.status === "OWNER_NOT_ACTIVE") return inactive(reply);
          return conflict(reply, result.status);
        }
        return reply.send({
          profile: serializeProfile(result.profile),
          status: result.status,
        });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.get<{ Params: ProfileParams }>(
    CRAFTSMAN_AUTHORING_PATHS.professions,
    {
      ...common,
      schema: { params: profileParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      try {
        const professions = await dependencies.professions.listOwned({
          actorUserId: actor,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
        });
        return reply.send({
          professions: professions.map(serializeProfession),
        });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.post<{ Body: AssignProfessionBody; Params: ProfileParams }>(
    CRAFTSMAN_AUTHORING_PATHS.professions,
    {
      ...write,
      preValidation: [
        rejectQuery,
        exactBody([
          "commandId",
          "craftsmanProfessionId",
          "declaredLevel",
          "professionCode",
        ]),
      ],
      schema: {
        body: assignProfessionSchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const governed = await dependencies.context.resolveCurrentProfession(
          request.body.professionCode,
        );
        if (governed === null)
          return conflict(reply, "PROFESSION_NOT_AVAILABLE");
        const result = await dependencies.professions.assign({
          actorUserId: actor,
          commandId: request.body.commandId,
          craftsmanProfessionId: request.body
            .craftsmanProfessionId as CraftsmanProfessionId,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          declaredLevel: request.body.declaredLevel,
          professionCode: governed.professionCode,
          taxonomyReleaseId: governed.taxonomyReleaseId,
        });
        if (!("profession" in result)) {
          return result.status === "PROFILE_UNAVAILABLE"
            ? notFound(reply)
            : conflict(reply, result.status);
        }
        return reply.code(result.status === "APPLIED" ? 201 : 200).send({
          profession: serializeProfession(result.profession),
          status: result.status,
        });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.get<{ Params: ProfileParams }>(
    CRAFTSMAN_AUTHORING_PATHS.services,
    {
      ...common,
      schema: { params: profileParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      try {
        const services = await dependencies.services.listOwned({
          actorUserId: actor,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
        });
        return reply.send({ services: services.map(serializeService) });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.post<{ Body: AddServiceBody; Params: ProfileParams }>(
    CRAFTSMAN_AUTHORING_PATHS.services,
    {
      ...write,
      preValidation: [
        rejectQuery,
        exactBody([
          "commandId",
          "craftsmanProfessionIds",
          "craftsmanServiceId",
          "serviceCode",
        ]),
      ],
      schema: {
        body: addServiceSchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const governed = await dependencies.context.resolveCurrentService(
          request.body.serviceCode,
        );
        if (governed === null) return conflict(reply, "SERVICE_NOT_AVAILABLE");
        const result = await dependencies.services.add({
          actorUserId: actor,
          commandId: request.body.commandId,
          craftsmanProfessionIds: request.body
            .craftsmanProfessionIds as CraftsmanProfessionId[],
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          craftsmanServiceId: request.body
            .craftsmanServiceId as CraftsmanServiceId,
          serviceCode: governed.serviceCode,
          taxonomyReleaseId: governed.taxonomyReleaseId,
        });
        if (!("service" in result)) {
          return result.status === "PROFILE_UNAVAILABLE"
            ? notFound(reply)
            : conflict(reply, result.status);
        }
        return reply.code(result.status === "APPLIED" ? 201 : 200).send({
          service: serializeService(result.service),
          status: result.status,
        });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.post<{ Body: { readonly commandId: string }; Params: ServiceParams }>(
    CRAFTSMAN_AUTHORING_PATHS.serviceDeactivate,
    {
      ...write,
      preValidation: [rejectQuery, exactBody(["commandId"])],
      schema: {
        body: commandOnlySchema,
        params: serviceParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.services.deactivate({
          actorUserId: actor,
          commandId: request.body.commandId,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          craftsmanServiceId: request.params
            .craftsmanServiceId as CraftsmanServiceId,
        });
        if (!("service" in result)) {
          return result.status === "PROFILE_UNAVAILABLE"
            ? notFound(reply)
            : conflict(reply, result.status);
        }
        return reply.send({
          service: serializeService(result.service),
          status: result.status,
        });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      readonly commandId: string;
      readonly declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER";
      readonly expectedDeclaredLevelRevision: number;
    };
    Params: ProfessionParams;
  }>(
    CRAFTSMAN_AUTHORING_PATHS.professionLevel,
    {
      ...write,
      preValidation: [
        rejectQuery,
        exactBody([
          "commandId",
          "declaredLevel",
          "expectedDeclaredLevelRevision",
        ]),
      ],
      schema: {
        body: changeLevelSchema,
        params: professionParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.professions.changeDeclaredLevel({
          actorUserId: actor,
          commandId: request.body.commandId,
          craftsmanProfessionId: request.params
            .craftsmanProfessionId as CraftsmanProfessionId,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          declaredLevel: request.body.declaredLevel,
          expectedDeclaredLevelRevision:
            request.body.expectedDeclaredLevelRevision,
        });
        if (!("profession" in result)) {
          return result.status === "PROFILE_UNAVAILABLE"
            ? notFound(reply)
            : conflict(reply, result.status);
        }
        return reply.send({
          profession: serializeProfession(result.profession),
          status: result.status,
        });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.post<{ Body: { readonly commandId: string }; Params: ProfessionParams }>(
    CRAFTSMAN_AUTHORING_PATHS.professionDeactivate,
    {
      ...write,
      preValidation: [rejectQuery, exactBody(["commandId"])],
      schema: {
        body: commandOnlySchema,
        params: professionParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.professions.deactivate({
          actorUserId: actor,
          commandId: request.body.commandId,
          craftsmanProfessionId: request.params
            .craftsmanProfessionId as CraftsmanProfessionId,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
        });
        if (!("profession" in result)) {
          return result.status === "PROFILE_UNAVAILABLE"
            ? notFound(reply)
            : conflict(reply, result.status);
        }
        return reply.send({
          profession: serializeProfession(result.profession),
          status: result.status,
        });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.get<{ Params: ProfileParams }>(
    CRAFTSMAN_AUTHORING_PATHS.serviceArea,
    {
      ...common,
      schema: { params: profileParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      try {
        const serviceArea = await dependencies.serviceAreas.findOwned({
          actorUserId: actor,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
        });
        return reply.send({ serviceArea: serializeServiceArea(serviceArea) });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.put<{ Body: ServiceAreaBody; Params: ProfileParams }>(
    CRAFTSMAN_AUTHORING_PATHS.serviceArea,
    {
      ...write,
      preValidation: [
        rejectQuery,
        exactBody([
          "baseMunicipalityCode",
          "commandId",
          "expectedRevision",
          "extraMunicipalityCodes",
          "maximumRadiusKm",
          "normalRadiusKm",
          "travelFeePolicy",
          "travelFeeThresholdKm",
        ]),
      ],
      schema: {
        body: serviceAreaSchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        const result = await dependencies.serviceAreas.replaceOwnedDraft({
          actorUserId: actor,
          baseMunicipalityCode: request.body
            .baseMunicipalityCode as MunicipalityCode | null,
          commandId: request.body.commandId,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
          expectedRevision: request.body.expectedRevision,
          extraMunicipalityCodes: request.body
            .extraMunicipalityCodes as readonly MunicipalityCode[],
          maximumRadiusKm: request.body.maximumRadiusKm,
          normalRadiusKm: request.body.normalRadiusKm,
          travelFeePolicy: request.body.travelFeePolicy,
          travelFeeThresholdKm: request.body.travelFeeThresholdKm,
        });
        if (!("serviceArea" in result)) {
          return result.status === "PROFILE_UNAVAILABLE"
            ? notFound(reply)
            : conflict(reply, result.status);
        }
        return reply.send({
          serviceArea: serializeServiceArea(result.serviceArea),
          status: result.status,
        });
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.get<{ Params: ProfileParams }>(
    CRAFTSMAN_AUTHORING_PATHS.publication,
    {
      ...common,
      schema: { params: profileParamsSchema, querystring: emptyQuerySchema },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, false);
      if (actor === null) return;
      try {
        const publication = await dependencies.publication.findOwned({
          actorUserId: actor,
          craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
        });
        return reply.send({ publication: serializePublication(publication) });
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.post<{
    Body: { readonly commandId: string; readonly expectedRevision: number };
    Params: ProfileParams;
  }>(
    CRAFTSMAN_AUTHORING_PATHS.publicationSubmit,
    {
      ...write,
      preValidation: [
        rejectQuery,
        exactBody(["commandId", "expectedRevision"]),
      ],
      schema: {
        body: publicationCommandSchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        return publicationResult(
          reply,
          await dependencies.publication.submitForReview({
            actorUserId: actor,
            commandId: request.body.commandId,
            craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
            expectedRevision: request.body.expectedRevision,
          }),
        );
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly visibility: "HIDDEN" | "PUBLIC";
    };
    Params: ProfileParams;
  }>(
    CRAFTSMAN_AUTHORING_PATHS.publicationVisibility,
    {
      ...write,
      preValidation: [
        rejectQuery,
        exactBody(["commandId", "expectedRevision", "visibility"]),
      ],
      schema: {
        body: visibilitySchema,
        params: profileParamsSchema,
        querystring: emptyQuerySchema,
      },
    },
    async (request, reply) => {
      const actor = await ownedActor(request, reply, dependencies, true);
      if (actor === null) return;
      try {
        return publicationResult(
          reply,
          await dependencies.publication.setOwnerVisibility({
            actorUserId: actor,
            commandId: request.body.commandId,
            craftsmanProfileId: request.params.profileId as CraftsmanProfileId,
            expectedRevision: request.body.expectedRevision,
            visibility: request.body.visibility,
          }),
        );
      } catch (error: unknown) {
        return commandError(reply, error);
      }
    },
  );
}

async function loadAggregate(
  actorUserId: UserId,
  dependencies: CraftsmanAuthoringRouteDependencies,
) {
  const profileId = await dependencies.context.findOwnedProfileId(actorUserId);
  if (profileId === null) return null;
  const service = createCraftsmanProfileService(dependencies.profiles);
  const [profile, professions, services, serviceArea, publication] =
    await Promise.all([
      service.getPrivateDraft({ actorUserId, profileId }),
      dependencies.professions.listOwned({
        actorUserId,
        craftsmanProfileId: profileId,
      }),
      dependencies.services.listOwned({
        actorUserId,
        craftsmanProfileId: profileId,
      }),
      dependencies.serviceAreas.findOwned({
        actorUserId,
        craftsmanProfileId: profileId,
      }),
      dependencies.publication.findOwned({
        actorUserId,
        craftsmanProfileId: profileId,
      }),
    ]);
  if (profile === null) return null;
  return {
    profile: serializeProfile(profile),
    professions: professions.map(serializeProfession),
    services: services.map(serializeService),
    publication: serializePublication(publication),
    serviceArea: serializeServiceArea(serviceArea),
  };
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
  publishing = false,
): Promise<UserId | null> {
  const result = await guard.evaluate(
    request,
    publishing ? "PUBLISHING" : undefined,
  );
  if (result.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return null;
  }
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return null;
  }
  return result.user.id;
}

async function ownedActor(
  request: FastifyRequest<{ Params: ProfileParams }>,
  reply: FastifyReply,
  dependencies: CraftsmanAuthoringRouteDependencies,
  publishing: boolean,
): Promise<UserId | null> {
  const actor = await activeActor(
    request,
    reply,
    dependencies.guard,
    publishing,
  );
  if (actor === null) return null;
  try {
    const owned = await dependencies.context.findOwnedProfileId(actor);
    if (owned !== request.params.profileId) {
      await notFound(reply);
      return null;
    }
    return actor;
  } catch {
    await unavailable(reply);
    return null;
  }
}

function serializeProfile(profile: CraftsmanProfile) {
  const common = {
    about: profile.about,
    createdAt: profile.createdAt.toISOString(),
    id: profile.id,
    identityVerified: profile.identityVerification !== null,
    profileType: profile.profileType,
    revision: profile.revision,
    updatedAt: profile.updatedAt.toISOString(),
  };
  return profile.profileType === "INDIVIDUAL"
    ? {
        ...common,
        nickname: profile.nickname,
        realFirstName: profile.realFirstName,
        realLastName: profile.realLastName,
      }
    : {
        ...common,
        companyRegistrationNumber: profile.companyRegistrationNumber,
        companyRegistrationVerified:
          profile.companyRegistrationVerification !== null,
        officialCompanyName: profile.officialCompanyName,
      };
}

function serializeProfession(profession: CraftsmanProfession) {
  return {
    createdAt: profession.createdAt.toISOString(),
    declaredLevel: profession.declaredLevel,
    declaredLevelRevision: profession.declaredLevelRevision,
    deactivatedAt: profession.deactivatedAt?.toISOString() ?? null,
    evidenceSupportedLevel: profession.evidenceSupportedLevel,
    id: profession.id,
    professionCode: profession.professionCode,
    taxonomyLabel: profession.taxonomyLabel ?? profession.professionCode,
    state: profession.state,
  };
}

function serializeService(service: CraftsmanService) {
  return {
    craftsmanProfessionIds: service.craftsmanProfessionIds,
    createdAt: service.createdAt.toISOString(),
    deactivatedAt: service.deactivatedAt?.toISOString() ?? null,
    id: service.id,
    serviceCode: service.serviceCode,
    taxonomyLabel: service.taxonomyLabel ?? service.serviceCode,
    state: service.state,
  };
}

function serializeServiceArea(serviceArea: CraftsmanServiceArea | null) {
  return serviceArea === null
    ? null
    : {
        baseMunicipalityCode: serviceArea.baseMunicipalityCode,
        createdAt: serviceArea.createdAt.toISOString(),
        extraMunicipalityCodes: serviceArea.extraMunicipalityCodes,
        maximumRadiusKm: serviceArea.maximumRadiusKm,
        normalRadiusKm: serviceArea.normalRadiusKm,
        revision: serviceArea.revision,
        travelFeePolicy: serviceArea.travelFeePolicy,
        travelFeeThresholdKm: serviceArea.travelFeeThresholdKm,
      };
}

function serializePublication(publication: CraftsmanPublicationState | null) {
  return publication === null
    ? null
    : {
        approvedAt: publication.approved?.occurredAt.toISOString() ?? null,
        changedAt: publication.changedAt?.toISOString() ?? null,
        effectivelyPublic: publication.effectivelyPublic,
        moderationState: publication.moderationState,
        ownerVisibility: publication.ownerVisibility,
        readiness: publication.readiness,
        rejection:
          publication.rejection === null
            ? null
            : {
                occurredAt: publication.rejection.occurredAt.toISOString(),
                reasonCode: publication.rejection.reasonCode,
                userFacingReason: publication.rejection.userFacingReason,
              },
        reviewState: publication.reviewState,
        revision: publication.revision,
      };
}

function publicationResult(
  reply: FastifyReply,
  result: Awaited<
    ReturnType<CraftsmanPublicationPersistence["submitForReview"]>
  >,
) {
  if ("publication" in result) {
    return reply.send({
      publication: serializePublication(result.publication),
      status: result.status,
    });
  }
  if (result.status === "PROFILE_UNAVAILABLE") return notFound(reply);
  if (result.status === "NOT_READY") {
    return reply
      .code(409)
      .send({ code: result.status, readiness: result.readiness });
  }
  if (
    result.status === "STALE_REVISION" ||
    result.status === "INVALID_TRANSITION"
  ) {
    return conflict(reply, result.status);
  }
  return unavailable(reply);
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
  if (error instanceof TypeError) {
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  }
  return unavailable(reply);
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
    if (!sameKeys(request.body, expected)) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}

const exactCreateProfileBody: preValidationHookHandler = (
  request,
  reply,
  done,
) => {
  const body = objectBody(request.body);
  const allowed =
    body?.["profileType"] === "INDIVIDUAL"
      ? ["about", "nickname", "profileType", "realFirstName", "realLastName"]
      : body?.["profileType"] === "COMPANY"
        ? [
            "about",
            "companyRegistrationNumber",
            "officialCompanyName",
            "profileType",
          ]
        : [];
  if (
    body === null ||
    allowed.length === 0 ||
    Object.keys(body).some((key) => !allowed.includes(key))
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
};

const exactReplaceProfileBody: preValidationHookHandler = (
  request,
  reply,
  done,
) => {
  const body = objectBody(request.body);
  const expected =
    body?.["profileType"] === "INDIVIDUAL"
      ? [
          "about",
          "expectedRevision",
          "nickname",
          "profileType",
          "realFirstName",
          "realLastName",
        ]
      : body?.["profileType"] === "COMPANY"
        ? [
            "about",
            "companyRegistrationNumber",
            "expectedRevision",
            "officialCompanyName",
            "profileType",
          ]
        : [];
  if (!sameKeys(body, expected.sort())) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
};

function objectBody(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameKeys(value: unknown, expected: readonly string[]): boolean {
  const body = objectBody(value);
  if (body === null) return false;
  const actual = Object.keys(body).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
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

function inactive(reply: FastifyReply) {
  return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
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

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const nullableText = (maxLength: number) =>
  ({
    anyOf: [{ maxLength, minLength: 1, type: "string" }, { type: "null" }],
  }) as const;
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
const professionParamsSchema = {
  additionalProperties: false,
  properties: { craftsmanProfessionId: uuid, profileId: uuid },
  required: ["profileId", "craftsmanProfessionId"],
  type: "object",
} as const;
const serviceParamsSchema = {
  additionalProperties: false,
  properties: { craftsmanServiceId: uuid, profileId: uuid },
  required: ["profileId", "craftsmanServiceId"],
  type: "object",
} as const;
const createProfileSchema = {
  additionalProperties: false,
  properties: {
    about: nullableText(2_000),
    companyRegistrationNumber: {
      anyOf: [{ pattern: "^[0-9]{8}$", type: "string" }, { type: "null" }],
    },
    nickname: nullableText(80),
    officialCompanyName: nullableText(200),
    profileType: { enum: ["INDIVIDUAL", "COMPANY"], type: "string" },
    realFirstName: nullableText(120),
    realLastName: nullableText(120),
  },
  required: ["profileType"],
  type: "object",
} as const;
const replaceProfileSchema = {
  ...createProfileSchema,
  properties: {
    ...createProfileSchema.properties,
    expectedRevision: { minimum: 1, type: "integer" },
  },
} as const;
const professionCode = {
  pattern: "^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$",
  type: "string",
} as const;
const proficiency = {
  enum: ["BEGINNER", "ADVANCED", "MASTER"],
  type: "string",
} as const;
const assignProfessionSchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    craftsmanProfessionId: uuid,
    declaredLevel: proficiency,
    professionCode,
  },
  required: [
    "commandId",
    "craftsmanProfessionId",
    "declaredLevel",
    "professionCode",
  ],
  type: "object",
} as const;
const addServiceSchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    craftsmanProfessionIds: {
      items: uuid,
      maxItems: 8,
      minItems: 1,
      type: "array",
      uniqueItems: true,
    },
    craftsmanServiceId: uuid,
    serviceCode: {
      pattern: "^SERV:[A-Z0-9][A-Z0-9_]{1,62}$",
      type: "string",
    },
  },
  required: [
    "commandId",
    "craftsmanProfessionIds",
    "craftsmanServiceId",
    "serviceCode",
  ],
  type: "object",
} as const;
const changeLevelSchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    declaredLevel: proficiency,
    expectedDeclaredLevelRevision: { minimum: 1, type: "integer" },
  },
  required: ["commandId", "declaredLevel", "expectedDeclaredLevelRevision"],
  type: "object",
} as const;
const commandOnlySchema = {
  additionalProperties: false,
  properties: { commandId: uuid },
  required: ["commandId"],
  type: "object",
} as const;
const municipality = {
  anyOf: [
    {
      maxLength: 64,
      minLength: 1,
      pattern: "^[A-Z0-9][A-Z0-9._:-]*$",
      type: "string",
    },
    { type: "null" },
  ],
} as const;
const radius = {
  anyOf: [
    { exclusiveMinimum: 0, maximum: 20_040, type: "number" },
    { type: "null" },
  ],
} as const;
const serviceAreaSchema = {
  additionalProperties: false,
  properties: {
    baseMunicipalityCode: municipality,
    commandId: uuid,
    expectedRevision: { minimum: 0, type: "integer" },
    extraMunicipalityCodes: {
      items: {
        maxLength: 64,
        minLength: 1,
        pattern: "^[A-Z0-9][A-Z0-9._:-]*$",
        type: "string",
      },
      maxItems: ALPHA_EXTRA_SERVICE_AREA_UI_LIMIT,
      type: "array",
      uniqueItems: true,
    },
    maximumRadiusKm: radius,
    normalRadiusKm: radius,
    travelFeePolicy: nullableText(1_000),
    travelFeeThresholdKm: radius,
  },
  required: [
    "baseMunicipalityCode",
    "commandId",
    "expectedRevision",
    "extraMunicipalityCodes",
    "maximumRadiusKm",
    "normalRadiusKm",
    "travelFeePolicy",
    "travelFeeThresholdKm",
  ],
  type: "object",
} as const;
const publicationCommandSchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    expectedRevision: { minimum: 0, type: "integer" },
  },
  required: ["commandId", "expectedRevision"],
  type: "object",
} as const;
const visibilitySchema = {
  ...publicationCommandSchema,
  properties: {
    ...publicationCommandSchema.properties,
    visibility: { enum: ["HIDDEN", "PUBLIC"], type: "string" },
  },
  required: [...publicationCommandSchema.required, "visibility"],
} as const;
