import type { FastifyRequest } from "fastify";

import type { AuthPersistence, AuthUser } from "./types.js";

export type SessionGuardResult =
  | { readonly status: "ACTIVE"; readonly user: AuthUser }
  | { readonly status: "ACCOUNT_NOT_ACTIVE"; readonly user: AuthUser }
  | { readonly status: "AUTHENTICATION_REQUIRED" };

export function createSessionGuard(persistence: AuthPersistence) {
  return Object.freeze({
    async evaluate(request: FastifyRequest): Promise<SessionGuardResult> {
      const userId = request.session.get("authUserId");
      if (userId === undefined) {
        return { status: "AUTHENTICATION_REQUIRED" };
      }
      const user = await persistence.findUserById(userId);
      if (user === undefined) {
        await request.session.destroy();
        return { status: "AUTHENTICATION_REQUIRED" };
      }
      return user.accountState === "ACTIVE"
        ? { status: "ACTIVE", user }
        : { status: "ACCOUNT_NOT_ACTIVE", user };
    },
  });
}
