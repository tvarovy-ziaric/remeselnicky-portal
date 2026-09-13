import type { UserId } from "@portal/domain";
import { expectTypeOf, it } from "vitest";

import {
  createAuthenticatedAuthorizationActor,
  createAuthorizationEvaluator,
  createServerAuthorizationContext,
  defineAuthorizationPolicy,
  denyAuthorization,
  resolveAuthorizationTarget,
} from "../src/index.js";

interface TypedTarget {
  readonly ownerId: UserId;
}

interface TypedContext {
  readonly relationship: "OWNER" | "PARTICIPANT";
}

it("preserves actor, target and context types through a policy", async () => {
  const policy = defineAuthorizationPolicy<
    "typed-resource",
    "read",
    TypedTarget,
    TypedContext
  >({
    accountRequirement: "AUTHENTICATED",
    action: "read",
    evaluate: (input) => {
      expectTypeOf(input.actor.userId).toEqualTypeOf<UserId>();
      expectTypeOf(input.target.ownerId).toEqualTypeOf<UserId>();
      expectTypeOf(input.context.relationship).toEqualTypeOf<
        "OWNER" | "PARTICIPANT"
      >();
      return denyAuthorization();
    },
    resource: "typed-resource",
  });
  const evaluator = createAuthorizationEvaluator([policy]);
  const actor = createAuthenticatedAuthorizationActor({
    accountState: "ACTIVE",
    id: "user-1" as UserId,
  });

  await evaluator.authorize(policy, {
    actor,
    context: createServerAuthorizationContext<TypedContext>({
      relationship: "OWNER",
    }),
    target: resolveAuthorizationTarget<TypedTarget>({ ownerId: actor.userId }),
  });

  if (process.env["PORTAL_RUN_INVALID_TYPE_TEST"] === "true") {
    await evaluator.authorize(policy, {
      actor,
      context: createServerAuthorizationContext<TypedContext>({
        relationship: "OWNER",
      }),
      // @ts-expect-error A raw target is not a server resolution.
      target: { ownerId: actor.userId },
    });
  }
});
