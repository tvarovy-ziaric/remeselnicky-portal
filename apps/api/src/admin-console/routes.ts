import type {
  AdminAccessService,
  AdminCapability,
  PrivilegedActor,
} from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";
import {
  ADMIN_CONSOLE_BASE_PATH,
  ADMIN_CONSOLE_MODULES,
  isAdminConsoleModuleId,
} from "./model.js";

export interface AdminConsoleRouteDependencies {
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly service: Pick<AdminAccessService, "authorize">;
}

export function registerAdminConsoleRoutes(
  app: FastifyInstance,
  dependencies: AdminConsoleRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith(ADMIN_CONSOLE_BASE_PATH)) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.get(ADMIN_CONSOLE_BASE_PATH, async (request, reply) => {
    const actor = await requireCapability(
      request,
      reply,
      dependencies,
      "admin.access",
    );
    if (actor === undefined) return;

    return reply.send({
      modules: Object.entries(ADMIN_CONSOLE_MODULES)
        .filter(([, module]) => actor.capabilities.has(module.capability))
        .map(([id, module]) => ({
          description: module.description,
          id,
          label: module.label,
        })),
    });
  });

  app.get<{ Params: { moduleId: string } }>(
    `${ADMIN_CONSOLE_BASE_PATH}/modules/:moduleId`,
    async (request, reply) => {
      const { moduleId } = request.params;
      if (!isAdminConsoleModuleId(moduleId)) {
        return reply.code(404).send({ code: "NOT_FOUND" });
      }
      const module = ADMIN_CONSOLE_MODULES[moduleId];
      const actor = await requireCapability(
        request,
        reply,
        dependencies,
        module.capability,
      );
      if (actor === undefined) return;

      return reply.send({
        description: module.description,
        id: moduleId,
        label: module.label,
        state: "PLACEHOLDER",
      });
    },
  );
}

async function requireCapability(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminConsoleRouteDependencies,
  capability: AdminCapability,
): Promise<PrivilegedActor | undefined> {
  const identity = await dependencies.guard.evaluate(request);
  if (identity.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return undefined;
  }
  if (identity.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  return authorizePrivilegedSession(
    request,
    reply,
    dependencies.service,
    identity.user.id,
    capability,
  );
}

async function authorizePrivilegedSession(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<AdminAccessService, "authorize">,
  userId: UserId,
  capability: AdminCapability,
): Promise<PrivilegedActor | undefined> {
  const decision = await service.authorize({
    capability,
    requireRecentMfa: false,
    sessionId: request.session.sessionId,
    userId,
  });
  if (decision.status !== "AUTHORIZED") {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    return undefined;
  }
  if (decision.actor.userId !== userId) {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    return undefined;
  }
  return decision.actor;
}
