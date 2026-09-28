import type { AdminAccessService } from "@portal/admin-auth";
import {
  AlphaRegistrationIntakeIdempotencyError,
  type AlphaRegistrationCommandResult,
  type AlphaRegistrationIntakeState,
  type AlphaRegistrationIntakeStatus,
  type AlphaRegistrationIssueResult,
} from "@portal/db";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";
import { AuthInputError, normalizeAndValidateEmail } from "../auth/service.js";

export const ADMIN_REGISTRATION_INTAKE_PATHS = Object.freeze({
  invitation: "/v1/admin/alpha-registration-intake/invitations",
  revokeInvitation:
    "/v1/admin/alpha-registration-intake/invitations/:invitationId/revoke",
  state: "/v1/admin/alpha-registration-intake/state",
  status: "/v1/admin/alpha-registration-intake",
});

export interface AdminRegistrationIntakeRouteDependencies {
  readonly adminAccess: Pick<AdminAccessService, "authorize">;
  readonly clock?: () => Date;
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly intake: {
    issue(input: {
      actorUserId: string;
      cohortCode: string;
      commandId: string;
      expiresAt: Date;
      normalizedEmail: string;
    }): Promise<AlphaRegistrationIssueResult>;
    readStatus(): Promise<AlphaRegistrationIntakeStatus>;
    revoke(input: {
      actorUserId: string;
      commandId: string;
      invitationId: string;
      reason: string;
    }): Promise<AlphaRegistrationCommandResult>;
    setState(input: {
      actorUserId: string;
      commandId: string;
      reason: string;
      state: AlphaRegistrationIntakeState;
    }): Promise<AlphaRegistrationCommandResult>;
  };
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

const uuid =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const commandProperties = {
  commandId: { type: "string", pattern: uuid },
  reason: { type: "string", minLength: 8, maxLength: 500 },
} as const;

export function registerAdminRegistrationIntakeRoutes(
  app: FastifyInstance,
  dependencies: AdminRegistrationIntakeRouteDependencies,
): void {
  const routeConfig = Object.freeze({
    rateLimit: {
      max: Math.min(10, dependencies.rateLimit.max),
      timeWindow: dependencies.rateLimit.timeWindowMs,
    },
  });

  app.get(
    ADMIN_REGISTRATION_INTAKE_PATHS.status,
    { config: routeConfig, onSend: noStore },
    async (request, reply) => {
      const actorUserId = await authorize(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const status = await dependencies.intake.readStatus();
        return reply.code(200).send({
          recordedAt: status.recordedAt.toISOString(),
          revision: status.revision,
          state: status.state,
        });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{
    Body: {
      commandId: string;
      reason: string;
      state: AlphaRegistrationIntakeState;
    };
  }>(
    ADMIN_REGISTRATION_INTAKE_PATHS.state,
    {
      config: routeConfig,
      onRequest: dependencies.csrfProtection,
      onSend: noStore,
      preValidation: exactBody(["commandId", "reason", "state"]),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["commandId", "reason", "state"],
          properties: {
            ...commandProperties,
            state: { type: "string", enum: ["OPEN", "PAUSED"] },
          },
        },
      },
    },
    async (request, reply) => {
      const actorUserId = await authorize(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.intake.setState({
          actorUserId,
          ...request.body,
        });
        return commandReply(reply, result);
      } catch (error) {
        return commandError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      cohortCode: string;
      commandId: string;
      email: string;
      expiresAt: string;
    };
  }>(
    ADMIN_REGISTRATION_INTAKE_PATHS.invitation,
    {
      config: routeConfig,
      onRequest: dependencies.csrfProtection,
      onSend: noStore,
      preValidation: exactBody([
        "cohortCode",
        "commandId",
        "email",
        "expiresAt",
      ]),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["cohortCode", "commandId", "email", "expiresAt"],
          properties: {
            cohortCode: {
              type: "string",
              pattern: "^[A-Z0-9][A-Z0-9_-]{1,63}$",
            },
            commandId: commandProperties.commandId,
            email: { type: "string", minLength: 3, maxLength: 254 },
            expiresAt: { type: "string", minLength: 20, maxLength: 35 },
          },
        },
      },
    },
    async (request, reply) => {
      const actorUserId = await authorize(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const expiresAt = new Date(request.body.expiresAt);
        const now = (dependencies.clock ?? (() => new Date()))();
        if (
          !Number.isFinite(expiresAt.valueOf()) ||
          expiresAt.valueOf() <= now.valueOf()
        )
          throw new TypeError("Invalid invitation expiry.");
        const result = await dependencies.intake.issue({
          actorUserId,
          cohortCode: request.body.cohortCode,
          commandId: request.body.commandId,
          expiresAt,
          normalizedEmail: normalizeAndValidateEmail(request.body.email),
        });
        if (result.status === "STALE_STATE")
          return reply.code(409).send({ code: "INTAKE_NOT_OPEN" });
        return reply.code(result.status === "APPLIED" ? 201 : 200).send({
          expiresAt: result.expiresAt.toISOString(),
          invitationId: result.invitationId,
          status: result.status,
        });
      } catch (error) {
        return commandError(reply, error);
      }
    },
  );

  app.post<{
    Body: { commandId: string; reason: string };
    Params: { invitationId: string };
  }>(
    ADMIN_REGISTRATION_INTAKE_PATHS.revokeInvitation,
    {
      config: routeConfig,
      onRequest: dependencies.csrfProtection,
      onSend: noStore,
      preValidation: exactBody(["commandId", "reason"]),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["commandId", "reason"],
          properties: commandProperties,
        },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["invitationId"],
          properties: { invitationId: { type: "string", pattern: uuid } },
        },
      },
    },
    async (request, reply) => {
      const actorUserId = await authorize(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.intake.revoke({
          actorUserId,
          commandId: request.body.commandId,
          invitationId: request.params.invitationId,
          reason: request.body.reason,
        });
        return commandReply(reply, result);
      } catch (error) {
        return commandError(reply, error);
      }
    },
  );
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminRegistrationIntakeRouteDependencies,
): Promise<string | undefined> {
  const identity = await dependencies.guard.evaluate(request);
  if (identity.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return undefined;
  }
  if (identity.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  const decision = await dependencies.adminAccess.authorize({
    capability: "admin.users.manage",
    requireRecentMfa: true,
    sessionId: request.session.sessionId,
    userId: identity.user.id,
  });
  if (
    decision.status !== "AUTHORIZED" ||
    decision.actor.userId !== identity.user.id ||
    !decision.actor.capabilities.has("admin.users.manage")
  ) {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    return undefined;
  }
  return identity.user.id;
}

function exactBody(keys: readonly string[]) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (error?: Error) => void,
  ): void => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(body, key))
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}

function commandReply(
  reply: FastifyReply,
  result: AlphaRegistrationCommandResult,
) {
  if (result.status === "NOT_FOUND")
    return reply.code(404).send({ code: "NOT_FOUND" });
  if (result.status === "STALE_STATE")
    return reply.code(409).send({ code: "STALE_STATE" });
  return reply
    .code(result.status === "APPLIED" ? 201 : 200)
    .send({ status: result.status });
}

function commandError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError || error instanceof AuthInputError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (error instanceof AlphaRegistrationIntakeIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function noStore(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  void reply.header("cache-control", "no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}
