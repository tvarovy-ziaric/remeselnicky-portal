import {
  isUserAccountState,
  type User,
  type UserAccountState,
  type UserId,
} from "@portal/domain";

const trustedActor = Symbol("portal.authorization.trusted-actor");

export interface AnonymousAuthorizationActor {
  readonly kind: "ANONYMOUS";
  readonly [trustedActor]: true;
}

export interface AuthenticatedAuthorizationActor {
  readonly accountState: UserAccountState;
  readonly kind: "AUTHENTICATED";
  readonly userId: UserId;
  readonly [trustedActor]: true;
}

export type AuthorizationActor =
  AnonymousAuthorizationActor | AuthenticatedAuthorizationActor;

export const anonymousAuthorizationActor: AnonymousAuthorizationActor =
  Object.freeze({
    kind: "ANONYMOUS",
    [trustedActor]: true as const,
  });

/**
 * Creates the minimal actor snapshot consumed by policies. The caller must pass
 * a User freshly loaded by trusted server code; arbitrary client claims are not
 * an identity source. Additional properties are deliberately not copied.
 */
export function createAuthenticatedAuthorizationActor(
  user: Pick<User, "accountState" | "id">,
): AuthenticatedAuthorizationActor {
  if (typeof user.id !== "string" || user.id.length === 0) {
    throw new Error("A server-loaded User ID is required");
  }
  if (!isUserAccountState(user.accountState)) {
    throw new Error("A current server-loaded account state is required");
  }

  return Object.freeze({
    accountState: user.accountState,
    kind: "AUTHENTICATED",
    userId: user.id,
    [trustedActor]: true as const,
  });
}

export function isTrustedAuthorizationActor(
  actor: unknown,
): actor is AuthorizationActor {
  if (typeof actor !== "object" || actor === null) {
    return false;
  }

  const candidate = actor as Partial<AuthorizationActor> & {
    readonly [trustedActor]?: unknown;
  };
  if (candidate[trustedActor] !== true) {
    return false;
  }
  if (candidate.kind === "ANONYMOUS") {
    return true;
  }

  return (
    candidate.kind === "AUTHENTICATED" &&
    typeof candidate.userId === "string" &&
    candidate.userId.length > 0 &&
    isUserAccountState(candidate.accountState)
  );
}
