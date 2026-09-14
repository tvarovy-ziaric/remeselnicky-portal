import { describe, expect, it } from "vitest";

import {
  R1_OWNER_ACTIONS,
  R1_OWNER_BOUNDARY_ACTORS,
  R1_OWNER_SURFACES,
  R1_PORTFOLIO_DELIVERY_SCENARIOS,
  R1_PRIVILEGED_REVIEW_ACTORS,
  R1_PRIVILEGED_REVIEW_SURFACES,
  R1_PUBLIC_PROFILE_SCENARIOS,
  verifyR1SupplySideMatrix,
  type R1SupplySideMatrixAdapter,
} from "../src/index.js";

describe("R1 supply-side authorization/privacy matrix", () => {
  it("covers every locked public, owner, privilege, portfolio and race axis", async () => {
    await expect(verifyR1SupplySideMatrix(validAdapter())).resolves.toEqual({
      ownerBoundaryProbes:
        R1_OWNER_SURFACES.length *
        R1_OWNER_ACTIONS.length *
        R1_OWNER_BOUNDARY_ACTORS.length,
      portfolioDeliveryProbes: R1_PORTFOLIO_DELIVERY_SCENARIOS.length,
      privilegedReviewProbes:
        R1_PRIVILEGED_REVIEW_SURFACES.length *
        R1_PRIVILEGED_REVIEW_ACTORS.length,
      publicProfileProbes: R1_PUBLIC_PROFILE_SCENARIOS.length,
      raceChecks: 2,
    });
  });

  it.each([
    [
      "public leak",
      (adapter: MutableAdapter) => {
        adapter.publicBody = { email: "private-owner@example.test" };
      },
    ],
    [
      "owner IDOR",
      (adapter: MutableAdapter) => {
        adapter.ownerDecision = () => true;
      },
    ],
    [
      "role-only admin privilege",
      (adapter: MutableAdapter) => {
        adapter.reviewDecision = () => true;
      },
    ],
    [
      "suspended owner privilege",
      (adapter: MutableAdapter) => {
        adapter.ownerDecision = (actor) =>
          actor === "OWNER" || actor === "SUSPENDED";
      },
    ],
    [
      "suspended exact reviewer privilege",
      (adapter: MutableAdapter) => {
        adapter.reviewDecision = (actor) =>
          actor === "MFA_CAPABILITY_ACTOR" || actor === "SUSPENDED";
      },
    ],
    [
      "portfolio intersection bypass",
      (adapter: MutableAdapter) => {
        adapter.portfolioDecision = () => true;
      },
    ],
    [
      "duplicate race effect",
      (adapter: MutableAdapter) => {
        adapter.raceEffectCount = 2;
      },
    ],
  ] as const)("rejects %s", async (_label, mutate) => {
    const adapter = mutableAdapter();
    mutate(adapter);
    await expect(verifyR1SupplySideMatrix(adapter)).rejects.toThrow();
  });

  it("rejects non-uniform hidden/suspended/unknown responses", async () => {
    const adapter = mutableAdapter();
    adapter.publicStatus = (scenario) =>
      scenario === "SUSPENDED"
        ? 403
        : scenario === "PUBLIC_APPROVED"
          ? 200
          : 404;
    await expect(verifyR1SupplySideMatrix(adapter)).rejects.toThrow(/404/u);
  });
});

interface MutableAdapter extends R1SupplySideMatrixAdapter {
  portfolioDecision: (scenario: string) => boolean;
  publicBody: unknown;
  publicStatus: (scenario: string) => number;
  raceEffectCount: number;
  reviewDecision: (actor: string) => boolean;
  ownerDecision: (actor: string) => boolean;
}

function validAdapter(): R1SupplySideMatrixAdapter {
  return mutableAdapter();
}

function mutableAdapter(): MutableAdapter {
  const adapter: MutableAdapter = {
    forbiddenMarkers: ["private-owner@example.test", "private/storage/key"],
    ownerDecision: (actor) => actor === "OWNER",
    portfolioDecision: (scenario) => scenario === "EXACT_PUBLIC_INTERSECTION",
    publicBody: publicProfileBody(),
    publicStatus: (scenario) => (scenario === "PUBLIC_APPROVED" ? 200 : 404),
    raceEffectCount: 1,
    reviewDecision: (actor) => actor === "MFA_CAPABILITY_ACTOR",
    probeOwnerBoundary({ actor }) {
      return Promise.resolve({ allowed: adapter.ownerDecision(actor) });
    },
    probePortfolioDelivery(scenario) {
      return Promise.resolve({
        allowed: adapter.portfolioDecision(scenario),
      });
    },
    probePrivilegedReview({ actor }) {
      return Promise.resolve({ allowed: adapter.reviewDecision(actor) });
    },
    readPublicProfile(scenario) {
      const publicProfile = scenario === "PUBLIC_APPROVED";
      return Promise.resolve({
        body: publicProfile ? adapter.publicBody : { code: "NOT_FOUND" },
        headers: {
          "cache-control": "no-store",
          "x-robots-tag": publicProfile ? "index, follow" : "noindex, nofollow",
        },
        statusCode: adapter.publicStatus(scenario),
      });
    },
    runCommandRaces() {
      return Promise.resolve({
        cas: {
          effectCount: adapter.raceEffectCount,
          outcomes: ["APPLIED", "STALE_REVISION"],
        },
        idempotency: {
          effectCount: adapter.raceEffectCount,
          outcomes: ["APPLIED", "DEDUPLICATED"],
          retryOutcome: "DEDUPLICATED",
        },
      });
    },
  };
  return adapter;
}

function publicProfileBody(): Record<string, unknown> {
  return {
    profileId: "74000000-0000-4000-8000-000000000001",
    identity: { primaryName: "Majster Ján" },
    professions: [],
    location: {},
    trust: {},
    callToAction: { kind: "PLATFORM_JOB_REQUEST" },
    portfolio: [],
    skills: [],
    specializations: [],
    indicativePricing: [],
    experience: null,
    credentials: [],
  };
}
