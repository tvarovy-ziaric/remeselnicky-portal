import type { SessionStore } from "@fastify/session";
import type { UserId } from "@portal/domain";
import type { Session } from "fastify";

import type { AuthPersistence, StoredSession } from "./types.js";

declare module "fastify" {
  interface Session {
    _csrf?: string;
    authUserId?: UserId;
  }
}

interface StoredSessionPayload extends Record<string, unknown> {
  readonly _csrf?: string;
  readonly authUserId?: UserId;
}

export function createPostgresSessionStore(input: {
  readonly clock?: () => Date;
  readonly cookieSecure: boolean;
  readonly persistence: AuthPersistence;
  readonly sessionTtlMs: number;
}): SessionStore {
  const clock = input.clock ?? (() => new Date());

  const store: SessionStore = {
    destroy(sessionId, callback): void {
      input.persistence.destroySession(sessionId).then(
        () => callback(),
        () => callback(new Error("Session persistence unavailable")),
      );
    },

    get(sessionId, callback): void {
      input.persistence.readSession(sessionId, clock()).then(
        (stored) => {
          if (stored === undefined) {
            callback(null, null);
            return;
          }
          const session = restoreSession(stored, {
            cookieSecure: input.cookieSecure,
            now: clock(),
          });
          callback(null, session);
        },
        () => callback(new Error("Session persistence unavailable")),
      );
    },

    set(sessionId, session, callback): void {
      const policyExpiresAt = new Date(clock().valueOf() + input.sessionTtlMs);
      const expiresAt =
        session.cookie.expires === undefined || session.cookie.expires === null
          ? policyExpiresAt
          : new Date(
              Math.min(
                session.cookie.expires.valueOf(),
                policyExpiresAt.valueOf(),
              ),
            );
      const payload: StoredSessionPayload = {
        ...(session._csrf === undefined ? {} : { _csrf: session._csrf }),
        ...(session.authUserId === undefined
          ? {}
          : { authUserId: session.authUserId }),
      };
      input.persistence
        .writeSession({
          expiresAt,
          id: sessionId,
          payload,
          userId: session.authUserId,
        })
        .then(
          () => callback(),
          () => callback(new Error("Session persistence unavailable")),
        );
    },
  };
  return Object.freeze(store);
}

function restoreSession(
  stored: StoredSession,
  canonical: { readonly cookieSecure: boolean; readonly now: Date },
): Session | null {
  const payload = stored.payload as Partial<StoredSessionPayload>;
  const remainingMs = Math.max(
    0,
    stored.expiresAt.valueOf() - canonical.now.valueOf(),
  );
  if (!Number.isFinite(stored.expiresAt.valueOf()) || remainingMs === 0) {
    return null;
  }
  const payloadUserId =
    typeof payload.authUserId === "string" ? payload.authUserId : undefined;
  if (payloadUserId !== stored.userId) {
    return null;
  }

  return {
    cookie: {
      expires: stored.expiresAt,
      httpOnly: true,
      maxAge: remainingMs,
      originalMaxAge: remainingMs,
      path: "/",
      sameSite: "lax",
      secure: canonical.cookieSecure,
    },
    ...(typeof payload._csrf === "string" ? { _csrf: payload._csrf } : {}),
    ...(stored.userId === undefined ? {} : { authUserId: stored.userId }),
  };
}
