import { randomUUID } from "node:crypto";

import { AUTH_API_PATHS } from "@portal/contracts";
import {
  JobRequestDraftIdempotencyError,
  normalizeJobRequestDraftSection,
  type CustomerProfileService,
  type JobRequestDraftPersistence,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

declare module "fastify" {
  interface Session {
    completedDraftHandoffId?: string;
    pendingDraftHandoffId?: string;
  }
}

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

export interface DraftHandoffRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly customerProfiles: CustomerProfileService;
  readonly drafts: Pick<
    JobRequestDraftPersistence,
    "createDraftWithInitialSectionOwned"
  >;
  readonly guard: Guard;
  readonly rateLimit: {
    readonly max: number;
    readonly timeWindowMs: number;
  };
}

export function registerDraftHandoffRoutes(
  app: FastifyInstance,
  dependencies: DraftHandoffRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (
      request.url === AUTH_API_PATHS.draftHandoffArm ||
      request.url === AUTH_API_PATHS.draftHandoffConsume
    ) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.post(
    AUTH_API_PATHS.draftHandoffArm,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
    },
    async (request, reply) => {
      request.session.set("pendingDraftHandoffId", randomUUID());
      delete request.session.completedDraftHandoffId;
      await request.session.save();
      return reply.code(204).send();
    },
  );

  app.post<{
    Body: {
      readonly section: {
        readonly key: string;
        readonly payload: unknown;
        readonly schemaVersion: number;
      };
    };
  }>(
    AUTH_API_PATHS.draftHandoffConsume,
    {
      bodyLimit: 40 * 1024,
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
      schema: { body: consumeSchema },
    },
    async (request, reply) => {
      const actor = await requireActiveActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actor === undefined) return;
      const handoffId =
        request.session.pendingDraftHandoffId ??
        request.session.completedDraftHandoffId;
      if (handoffId === undefined) {
        return reply.code(404).send({ code: "HANDOFF_UNAVAILABLE" });
      }
      try {
        const customer =
          await dependencies.customerProfiles.ensureForCustomerUse(actor);
        const section = normalizeJobRequestDraftSection(request.body.section);
        const result =
          await dependencies.drafts.createDraftWithInitialSectionOwned({
            actorUserId: actor,
            commandId: handoffId,
            customerProfileId: customer.profile.id,
            section,
          });
        if (result.status === "ACCOUNT_NOT_ACTIVE") {
          return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
        }
        if (!("jobRequestId" in result)) {
          return reply.code(404).send({ code: "HANDOFF_UNAVAILABLE" });
        }
        if (request.session.pendingDraftHandoffId !== undefined) {
          request.session.set("completedDraftHandoffId", handoffId);
          delete request.session.pendingDraftHandoffId;
          await request.session.save();
        }
        return reply.send({
          jobRequestId: result.jobRequestId,
          revision: result.revision,
        });
      } catch (error: unknown) {
        if (isAccountNotActive(error)) {
          return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
        }
        if (error instanceof JobRequestDraftIdempotencyError) {
          return reply.code(409).send({ code: "HANDOFF_CONFLICT" });
        }
        if (error instanceof TypeError) {
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        }
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
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

const consumeSchema = {
  additionalProperties: false,
  properties: {
    section: {
      additionalProperties: false,
      properties: {
        key: { maxLength: 64, minLength: 1, type: "string" },
        payload: { type: "object" },
        schemaVersion: { maximum: 65_535, minimum: 1, type: "integer" },
      },
      required: ["key", "payload", "schemaVersion"],
      type: "object",
    },
  },
  required: ["section"],
  type: "object",
} as const;
