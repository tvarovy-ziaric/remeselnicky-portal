import { createHmac } from "node:crypto";

import type { AdminAccessService } from "@portal/admin-auth";
import {
  ADMIN_AUTH_API_PATHS,
  type AdminMfaChallengeRequest,
  type AdminMfaChallengeResponse,
  type AdminMfaVerifyRequest,
  type AdminSessionResponse,
} from "@portal/contracts";
import type { UserId } from "@portal/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";
import type { AuthPersistence, AuthRuntimeConfig } from "../auth/types.js";
import { registerAdminConsoleRoutes } from "../admin-console/index.js";

export interface AdminAuthRouteDependencies {
  readonly config: Pick<
    AuthRuntimeConfig,
    "rateLimitMax" | "rateLimitWindowMs" | "sessionSecret"
  >;
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly persistence: Pick<AuthPersistence, "consumeRateLimit">;
  readonly service: AdminAccessService;
}

export function registerAdminAuthRoutes(
  app: FastifyInstance,
  dependencies: AdminAuthRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/v1/admin/")) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.post<{ Body: AdminMfaChallengeRequest }>(
    ADMIN_AUTH_API_PATHS.challenge,
    {
      onRequest: csrfProtection(app),
      schema: { body: challengeSchema },
    },
    async (request, reply) => {
      const userId = await requireActiveUser(request, reply, dependencies);
      if (userId === undefined) return;
      if (!(await consumeAdminRateLimit(request, userId, dependencies))) {
        return reply.code(429).send({ code: "RATE_LIMITED" });
      }
      const result = await dependencies.service.beginMfa({
        purpose: request.body.purpose,
        userId,
      });
      if (result.status !== "CHALLENGE_CREATED") {
        return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
      }
      const response: AdminMfaChallengeResponse = {
        challengeToken: result.challengeToken,
        factorKind: result.factorKind,
        publicChallenge: result.publicChallenge,
      };
      return reply.send(response);
    },
  );

  app.post<{ Body: AdminMfaVerifyRequest }>(
    ADMIN_AUTH_API_PATHS.verify,
    {
      onRequest: csrfProtection(app),
      schema: { body: verifySchema },
    },
    async (request, reply) => {
      const userId = await requireActiveUser(request, reply, dependencies);
      if (userId === undefined) return;
      if (!(await consumeAdminRateLimit(request, userId, dependencies))) {
        return reply.code(429).send({ code: "RATE_LIMITED" });
      }
      await request.session.regenerate(["authUserId"]);
      await request.session.save();
      const result = await dependencies.service.verifyMfa({
        challengeToken: request.body.challengeToken,
        response: request.body.response,
        sessionId: request.session.sessionId,
        userId,
      });
      if (result.status !== "VERIFIED") {
        return reply.code(401).send({ code: "MFA_INVALID" });
      }
      return reply.code(204).send();
    },
  );

  app.get(ADMIN_AUTH_API_PATHS.session, async (request, reply) => {
    const userId = await requireActiveUser(request, reply, dependencies);
    if (userId === undefined) return;
    const decision = await dependencies.service.authorize({
      capability: "admin.access",
      requireRecentMfa: false,
      sessionId: request.session.sessionId,
      userId,
    });
    if (decision.status !== "AUTHORIZED") {
      return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    }
    const response: AdminSessionResponse = {
      capabilities: [...decision.actor.capabilities].sort(),
      mfaAuthenticatedAt: decision.actor.mfaAuthenticatedAt.toISOString(),
      roles: [...decision.actor.roles],
    };
    return reply.send(response);
  });

  registerAdminConsoleRoutes(app, dependencies);
}

async function requireActiveUser(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminAuthRouteDependencies,
): Promise<UserId | undefined> {
  const result = await dependencies.guard.evaluate(request);
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

async function consumeAdminRateLimit(
  request: FastifyRequest,
  userId: UserId,
  dependencies: AdminAuthRouteDependencies,
): Promise<boolean> {
  const userLimit = Math.min(5, dependencies.config.rateLimitMax);
  const ipLimit = Math.min(
    30,
    Math.max(10, dependencies.config.rateLimitMax * 3),
  );
  const userBucket = await dependencies.persistence.consumeRateLimit({
    keyDigest: keyedDigest(
      dependencies.config.sessionSecret,
      `admin-mfa-user:${userId}`,
    ),
    limit: userLimit,
    now: new Date(),
    scope: "admin-mfa-user",
    timeWindowMs: dependencies.config.rateLimitWindowMs,
  });
  const ipBucket = await dependencies.persistence.consumeRateLimit({
    keyDigest: keyedDigest(
      dependencies.config.sessionSecret,
      `admin-mfa-ip:${request.ip}`,
    ),
    limit: ipLimit,
    now: new Date(),
    scope: "admin-mfa-ip",
    timeWindowMs: dependencies.config.rateLimitWindowMs,
  });
  return userBucket.current <= userLimit && ipBucket.current <= ipLimit;
}

function keyedDigest(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function csrfProtection(app: FastifyInstance) {
  return (
    request: Parameters<FastifyInstance["csrfProtection"]>[0],
    reply: Parameters<FastifyInstance["csrfProtection"]>[1],
    done: Parameters<FastifyInstance["csrfProtection"]>[2],
  ): void => app.csrfProtection(request, reply, done);
}

const challengeSchema = {
  additionalProperties: false,
  properties: {
    purpose: { enum: ["PRIVILEGED_SESSION", "ROLE_CHANGE"], type: "string" },
  },
  required: ["purpose"],
  type: "object",
} as const;

const verifySchema = {
  additionalProperties: false,
  properties: {
    challengeToken: {
      maxLength: 128,
      minLength: 40,
      pattern: "^[A-Za-z0-9_-]+$",
      type: "string",
    },
    response: { maxLength: 8192, minLength: 1, type: "string" },
  },
  required: ["challengeToken", "response"],
  type: "object",
} as const;
