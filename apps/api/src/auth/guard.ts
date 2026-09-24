import type { FastifyRequest } from "fastify";
import type { ModerationEnforcementScope } from "@portal/db";

import type { AuthPersistence, AuthUser } from "./types.js";

export type SessionGuardResult =
  | { readonly status: "ACTIVE"; readonly user: AuthUser }
  | { readonly status: "ACCOUNT_NOT_ACTIVE"; readonly user: AuthUser }
  | { readonly status: "AUTHENTICATION_REQUIRED" };

export type SessionAuthorizationScope =
  | Exclude<ModerationEnforcementScope, "CONTENT" | "ACCOUNT">
  | "RESTRICTED_ACCOUNT_APPEAL";

export function createSessionGuard(persistence: AuthPersistence) {
  return Object.freeze({
    async evaluate(
      request: FastifyRequest,
      scope?: SessionAuthorizationScope,
    ): Promise<SessionGuardResult> {
      const userId = request.session.get("authUserId");
      if (userId === undefined) {
        return { status: "AUTHENTICATION_REQUIRED" };
      }
      const user = await persistence.findUserById(userId);
      if (user === undefined) {
        await request.session.destroy();
        return { status: "AUTHENTICATION_REQUIRED" };
      }
      if (user.accountState !== "ACTIVE") {
        return { status: "ACCOUNT_NOT_ACTIVE", user };
      }
      if (scope === "RESTRICTED_ACCOUNT_APPEAL") {
        return { status: "ACTIVE", user };
      }
      // D24 preserves Job and business history while restricting new actions.
      // Safe reads therefore remain available for an ACTIVE account even when
      // an ACCOUNT restriction is in force; object/field policies still run.
      if (request.method === "GET" || request.method === "HEAD") {
        return { status: "ACTIVE", user };
      }
      const restricted = new Set(user.activeModerationScopes);
      return restricted.has("ACCOUNT") ||
        (scope !== undefined && restricted.has(scope))
        ? { status: "ACCOUNT_NOT_ACTIVE", user }
        : { status: "ACTIVE", user };
    },
  });
}
