import {
  isTrustedAuthorizationActor,
  type AuthenticatedAuthorizationActor,
  type AuthorizationActor,
} from "./actor.js";
import {
  authorizationDecision,
  type AuthorizationDecision,
} from "./decision.js";

const policyDefinition = Symbol("portal.authorization.policy-definition");
const targetResolution = Symbol("portal.authorization.target-resolution");
const trustedContext = Symbol("portal.authorization.trusted-context");

const safeIdentifier = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;

export const AUTHORIZATION_ACCOUNT_REQUIREMENTS = Object.freeze([
  "AUTHENTICATED",
  "ACTIVE",
] as const);

export type AuthorizationAccountRequirement =
  (typeof AUTHORIZATION_ACCOUNT_REQUIREMENTS)[number];

export type AuthorizationPolicyOutcome =
  { readonly effect: "DENY" } | { readonly effect: "PERMIT" };

const deniedPolicyOutcome: AuthorizationPolicyOutcome = Object.freeze({
  effect: "DENY",
});
const permittedPolicyOutcome: AuthorizationPolicyOutcome = Object.freeze({
  effect: "PERMIT",
});

export function denyAuthorization(): AuthorizationPolicyOutcome {
  return deniedPolicyOutcome;
}

export function permitAuthorization(): AuthorizationPolicyOutcome {
  return permittedPolicyOutcome;
}

export interface ResolvedAuthorizationTarget<Target extends object> {
  readonly status: "RESOLVED";
  readonly value: Target;
  readonly [targetResolution]: true;
}

export interface UnresolvedAuthorizationTarget {
  readonly status: "UNRESOLVED";
  readonly [targetResolution]: true;
}

export type AuthorizationTarget<Target extends object> =
  ResolvedAuthorizationTarget<Target> | UnresolvedAuthorizationTarget;

const unresolvedTarget: UnresolvedAuthorizationTarget = Object.freeze({
  status: "UNRESOLVED",
  [targetResolution]: true as const,
});

/** Wraps an object resolved by trusted server-side persistence code. */
export function resolveAuthorizationTarget<Target extends object>(
  target: Target,
): ResolvedAuthorizationTarget<Target> {
  if (target === null) {
    throw new Error("A resolved authorization target is required");
  }
  return Object.freeze({
    status: "RESOLVED",
    value: target,
    [targetResolution]: true as const,
  });
}

/** Represents a failed server-side target lookup without retaining an ID. */
export function unresolvedAuthorizationTarget(): UnresolvedAuthorizationTarget {
  return unresolvedTarget;
}

export interface ServerAuthorizationContext<Context extends object> {
  readonly value: Readonly<Context>;
  readonly [trustedContext]: true;
}

/**
 * Marks policy context assembled by server code. Route adapters must derive it
 * from authoritative persistence/services rather than raw client claims.
 */
export function createServerAuthorizationContext<Context extends object>(
  context: Context,
): ServerAuthorizationContext<Context> {
  if (context === null) {
    throw new Error("A server authorization context is required");
  }
  return Object.freeze({
    value: Object.freeze({ ...context }),
    [trustedContext]: true as const,
  });
}

export interface AuthorizationPolicyInput<
  Target extends object,
  Context extends object,
> {
  readonly actor: AuthenticatedAuthorizationActor;
  readonly context: Readonly<Context>;
  readonly target: Target;
}

export interface AuthorizationPolicyDefinition<
  Resource extends string,
  Action extends string,
  Target extends object,
  Context extends object,
> {
  readonly accountRequirement: AuthorizationAccountRequirement;
  readonly action: Action;
  readonly evaluate: (
    input: AuthorizationPolicyInput<Target, Context>,
  ) => AuthorizationPolicyOutcome | Promise<AuthorizationPolicyOutcome>;
  readonly resource: Resource;
  readonly [policyDefinition]: true;
}

export function defineAuthorizationPolicy<
  const Resource extends string,
  const Action extends string,
  Target extends object,
  Context extends object,
>(definition: {
  readonly accountRequirement: AuthorizationAccountRequirement;
  readonly action: Action;
  readonly evaluate: (
    input: AuthorizationPolicyInput<Target, Context>,
  ) => AuthorizationPolicyOutcome | Promise<AuthorizationPolicyOutcome>;
  readonly resource: Resource;
}): AuthorizationPolicyDefinition<Resource, Action, Target, Context> {
  assertSafeIdentifier(definition.resource, "resource");
  assertSafeIdentifier(definition.action, "action");

  return Object.freeze({
    ...definition,
    [policyDefinition]: true as const,
  });
}

export interface AuthorizationRequest<
  Target extends object,
  Context extends object,
> {
  readonly actor: AuthorizationActor;
  readonly context: ServerAuthorizationContext<Context>;
  readonly target: AuthorizationTarget<Target>;
}

export interface AuthorizationEvaluator {
  authorize<
    Resource extends string,
    Action extends string,
    Target extends object,
    Context extends object,
  >(
    policy: AuthorizationPolicyDefinition<Resource, Action, Target, Context>,
    request: AuthorizationRequest<NoInfer<Target>, NoInfer<Context>>,
  ): Promise<AuthorizationDecision>;
}

type ErasedPolicyDefinition = AuthorizationPolicyDefinition<
  string,
  string,
  never,
  never
>;

export function createAuthorizationEvaluator(
  policies: readonly ErasedPolicyDefinition[],
): AuthorizationEvaluator {
  const registeredPolicies = new Set<object>();
  const policyKeys = new Set<string>();

  for (const policy of policies) {
    if (!isAuthorizationPolicyDefinition(policy)) {
      throw new Error(
        "Only server-defined authorization policies can register",
      );
    }
    const key = `${policy.resource}\u0000${policy.action}`;
    if (policyKeys.has(key)) {
      throw new Error(
        `Duplicate authorization policy: ${policy.resource}/${policy.action}`,
      );
    }
    policyKeys.add(key);
    registeredPolicies.add(policy);
  }

  return Object.freeze({
    async authorize<
      Resource extends string,
      Action extends string,
      Target extends object,
      Context extends object,
    >(
      policy: AuthorizationPolicyDefinition<Resource, Action, Target, Context>,
      request: AuthorizationRequest<NoInfer<Target>, NoInfer<Context>>,
    ): Promise<AuthorizationDecision> {
      if (!registeredPolicies.has(policy)) {
        return authorizationDecision("POLICY_NOT_REGISTERED");
      }
      if (!isTrustedAuthorizationActor(request.actor)) {
        return authorizationDecision("ACTOR_UNTRUSTED");
      }
      if (request.actor.kind === "ANONYMOUS") {
        return authorizationDecision("ACTOR_REQUIRED");
      }
      if (
        policy.accountRequirement === "ACTIVE" &&
        request.actor.accountState !== "ACTIVE"
      ) {
        return authorizationDecision("ACCOUNT_NOT_ACTIVE");
      }
      if (!isResolvedTarget(request.target)) {
        return authorizationDecision("TARGET_NOT_RESOLVED");
      }
      if (!isTrustedContext(request.context)) {
        return authorizationDecision("CONTEXT_UNTRUSTED");
      }

      try {
        const outcome = await policy.evaluate({
          actor: request.actor,
          context: request.context.value,
          target: request.target.value,
        });
        if (!isPolicyOutcome(outcome)) {
          return authorizationDecision("POLICY_INVALID_RESULT");
        }
        return outcome.effect === "PERMIT"
          ? authorizationDecision("POLICY_PERMITTED")
          : authorizationDecision("POLICY_DENIED");
      } catch {
        return authorizationDecision("POLICY_ERROR");
      }
    },
  });
}

function isAuthorizationPolicyDefinition(
  value: unknown,
): value is ErasedPolicyDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    policyDefinition in value &&
    value[policyDefinition] === true
  );
}

function isResolvedTarget<Target extends object>(
  value: AuthorizationTarget<Target>,
): value is ResolvedAuthorizationTarget<Target> {
  return (
    typeof value === "object" &&
    value !== null &&
    value[targetResolution] === true &&
    value.status === "RESOLVED" &&
    typeof value.value === "object" &&
    value.value !== null
  );
}

function isTrustedContext<Context extends object>(
  value: ServerAuthorizationContext<Context>,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    value[trustedContext] === true &&
    typeof value.value === "object" &&
    value.value !== null
  );
}

function isPolicyOutcome(value: unknown): value is AuthorizationPolicyOutcome {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const effect = (value as { readonly effect?: unknown }).effect;
  return effect === "DENY" || effect === "PERMIT";
}

export function assertSafeIdentifier(value: string, label: string): void {
  if (!safeIdentifier.test(value)) {
    throw new Error(
      `Authorization ${label} must be a stable lowercase identifier`,
    );
  }
}
