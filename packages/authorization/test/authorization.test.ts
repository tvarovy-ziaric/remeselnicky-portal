import type { User, UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  anonymousAuthorizationActor,
  createAuthenticatedAuthorizationActor,
  createAuthorizationEvaluator,
  createServerAuthorizationContext,
  defineAuthorizationPolicy,
  denyAuthorization,
  permitAuthorization,
  resolveAuthorizationTarget,
  unresolvedAuthorizationTarget,
  type AuthorizationActor,
  type AuthorizationPolicyOutcome,
  type ServerAuthorizationContext,
} from "../src/index.js";

interface PrivateRecord {
  readonly id: string;
  readonly ownerId: UserId;
}

interface RelationshipContext {
  readonly participantIds: readonly UserId[];
}

const aliceId = "018f4f58-e741-7b63-8742-88c9f09b2382" as UserId;
const bobId = "018f4f58-e741-7b63-8742-88c9f09b2383" as UserId;

function user(id: UserId, accountState: User["accountState"] = "ACTIVE"): User {
  const timestamp = new Date("2026-09-14T00:00:00.000Z");
  return {
    accountState,
    accountStateChangedAt: timestamp,
    createdAt: timestamp,
    id,
    updatedAt: timestamp,
  };
}

function context(
  participantIds: readonly UserId[] = [],
): ServerAuthorizationContext<RelationshipContext> {
  return createServerAuthorizationContext({ participantIds });
}

const record: PrivateRecord = { id: "private-1", ownerId: aliceId };

describe("private authorization policies", () => {
  it("permits only when a registered server policy explicitly permits", async () => {
    const readPolicy = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: ({ actor, target }) =>
        actor.userId === target.ownerId
          ? permitAuthorization()
          : denyAuthorization(),
      resource: "private-record",
    });
    const evaluator = createAuthorizationEvaluator([readPolicy]);

    await expect(
      evaluator.authorize(readPolicy, {
        actor: createAuthenticatedAuthorizationActor(user(aliceId)),
        context: context(),
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toEqual({ effect: "PERMIT", reason: "POLICY_PERMITTED" });
    await expect(
      evaluator.authorize(readPolicy, {
        actor: createAuthenticatedAuthorizationActor(user(bobId)),
        context: context(),
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toEqual({ effect: "DENY", reason: "POLICY_DENIED" });
  });

  it("denies a missing policy, including an unregistered copy of a known key", async () => {
    const registered = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: () => permitAuthorization(),
      resource: "private-record",
    });
    const unregisteredCopy = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: () => permitAuthorization(),
      resource: "private-record",
    });
    const evaluator = createAuthorizationEvaluator([registered]);

    await expect(
      evaluator.authorize(unregisteredCopy, {
        actor: createAuthenticatedAuthorizationActor(user(aliceId)),
        context: context(),
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toEqual({
      effect: "DENY",
      reason: "POLICY_NOT_REGISTERED",
    });
  });

  it("denies an unresolved target before policy evaluation", async () => {
    const evaluate = vi.fn(() => permitAuthorization());
    const policy = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate,
      resource: "private-record",
    });
    const evaluator = createAuthorizationEvaluator([policy]);

    await expect(
      evaluator.authorize(policy, {
        actor: createAuthenticatedAuthorizationActor(user(aliceId)),
        context: context(),
        target: unresolvedAuthorizationTarget(),
      }),
    ).resolves.toEqual({
      effect: "DENY",
      reason: "TARGET_NOT_RESOLVED",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("requires an authenticated actor for every private policy", async () => {
    const policy = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: () => permitAuthorization(),
      resource: "private-record",
    });

    await expect(
      createAuthorizationEvaluator([policy]).authorize(policy, {
        actor: anonymousAuthorizationActor,
        context: context(),
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toEqual({ effect: "DENY", reason: "ACTOR_REQUIRED" });
  });

  it.each(["SUSPENDED", "DEACTIVATED"] as const)(
    "blocks ACTIVE policies for the current %s account state",
    async (accountState) => {
      const evaluate = vi.fn(() => permitAuthorization());
      const policy = defineAuthorizationPolicy<
        "private-record",
        "update",
        PrivateRecord,
        RelationshipContext
      >({
        accountRequirement: "ACTIVE",
        action: "update",
        evaluate,
        resource: "private-record",
      });

      await expect(
        createAuthorizationEvaluator([policy]).authorize(policy, {
          actor: createAuthenticatedAuthorizationActor(
            user(aliceId, accountState),
          ),
          context: context(),
          target: resolveAuthorizationTarget(record),
        }),
      ).resolves.toEqual({
        effect: "DENY",
        reason: "ACCOUNT_NOT_ACTIVE",
      });
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it("does not infer write permission from an allowed read policy", async () => {
    const readPolicy = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: () => permitAuthorization(),
      resource: "private-record",
    });
    const updatePolicy = defineAuthorizationPolicy<
      "private-record",
      "update",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "ACTIVE",
      action: "update",
      evaluate: () => denyAuthorization(),
      resource: "private-record",
    });
    const evaluator = createAuthorizationEvaluator([readPolicy, updatePolicy]);
    const request = {
      actor: createAuthenticatedAuthorizationActor(user(aliceId)),
      context: context(),
      target: resolveAuthorizationTarget(record),
    };

    await expect(
      evaluator.authorize(readPolicy, request),
    ).resolves.toMatchObject({ effect: "PERMIT" });
    await expect(evaluator.authorize(updatePolicy, request)).resolves.toEqual({
      effect: "DENY",
      reason: "POLICY_DENIED",
    });
  });

  it("supports typed participant context without embedding a permission matrix", async () => {
    const policy = defineAuthorizationPolicy<
      "work-context",
      "observe",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "observe",
      evaluate: ({ actor, context: serverContext }) =>
        serverContext.participantIds.includes(actor.userId)
          ? permitAuthorization()
          : denyAuthorization(),
      resource: "work-context",
    });
    const evaluator = createAuthorizationEvaluator([policy]);

    await expect(
      evaluator.authorize(policy, {
        actor: createAuthenticatedAuthorizationActor(user(bobId)),
        context: context([bobId]),
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toMatchObject({ effect: "PERMIT" });
    await expect(
      evaluator.authorize(policy, {
        actor: createAuthenticatedAuthorizationActor(user(bobId)),
        context: context([]),
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toMatchObject({ effect: "DENY" });
  });

  it("rejects raw client actor and context claims", async () => {
    const policy = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: () => permitAuthorization(),
      resource: "private-record",
    });
    const evaluator = createAuthorizationEvaluator([policy]);
    const clientActorClaim = {
      accountState: "ACTIVE",
      kind: "AUTHENTICATED",
      role: "SUPER_ADMIN",
      userId: aliceId,
    } as unknown as AuthorizationActor;

    await expect(
      evaluator.authorize(policy, {
        actor: clientActorClaim,
        context: context(),
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toEqual({ effect: "DENY", reason: "ACTOR_UNTRUSTED" });

    const serverUserWithIgnoredClientClaim = {
      ...user(aliceId),
      role: "SUPER_ADMIN",
    };
    const actor = createAuthenticatedAuthorizationActor(
      serverUserWithIgnoredClientClaim,
    );
    expect("role" in actor).toBe(false);

    await expect(
      evaluator.authorize(policy, {
        actor,
        context: {
          value: { participantIds: [aliceId], role: "SUPER_ADMIN" },
        } as unknown as ServerAuthorizationContext<RelationshipContext>,
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toEqual({ effect: "DENY", reason: "CONTEXT_UNTRUSTED" });
  });

  it.each([
    {
      expected: "POLICY_ERROR",
      evaluate: () => {
        throw new Error("sensitive persistence detail");
      },
    },
    {
      expected: "POLICY_ERROR",
      evaluate: () => Promise.reject(new Error("sensitive async detail")),
    },
    {
      expected: "POLICY_INVALID_RESULT",
      evaluate: () =>
        ({ effect: "ALLOW" }) as unknown as AuthorizationPolicyOutcome,
    },
  ])("fails closed with $expected", async ({ evaluate, expected }) => {
    const policy = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate,
      resource: "private-record",
    });

    await expect(
      createAuthorizationEvaluator([policy]).authorize(policy, {
        actor: createAuthenticatedAuthorizationActor(user(aliceId)),
        context: context(),
        target: resolveAuthorizationTarget(record),
      }),
    ).resolves.toEqual({ effect: "DENY", reason: expected });
  });

  it("rejects duplicate policy keys and unsafe log identifiers", () => {
    const first = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: () => denyAuthorization(),
      resource: "private-record",
    });
    const duplicate = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: () => denyAuthorization(),
      resource: "private-record",
    });

    expect(() => createAuthorizationEvaluator([first, duplicate])).toThrow(
      /Duplicate authorization policy/u,
    );
    expect(() =>
      defineAuthorizationPolicy({
        accountRequirement: "ACTIVE",
        action: "read/private-id-123",
        evaluate: () => denyAuthorization(),
        resource: "private-record",
      }),
    ).toThrow(/stable lowercase identifier/u);
  });

  it("returns minimal frozen decisions without actor, target, context or errors", async () => {
    const policy = defineAuthorizationPolicy<
      "private-record",
      "read",
      PrivateRecord,
      RelationshipContext
    >({
      accountRequirement: "AUTHENTICATED",
      action: "read",
      evaluate: () => {
        throw new Error("must-not-leak");
      },
      resource: "private-record",
    });
    const decision = await createAuthorizationEvaluator([policy]).authorize(
      policy,
      {
        actor: createAuthenticatedAuthorizationActor(user(aliceId)),
        context: context([aliceId]),
        target: resolveAuthorizationTarget(record),
      },
    );

    expect(decision).toEqual({ effect: "DENY", reason: "POLICY_ERROR" });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(JSON.stringify(decision)).not.toMatch(
      /alice|private-1|must-not-leak|participant/u,
    );
  });
});
