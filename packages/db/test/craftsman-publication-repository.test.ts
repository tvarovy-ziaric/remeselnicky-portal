import type { CraftsmanProfileId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanPublicationRepository,
  CraftsmanPublicationIdempotencyError,
} from "../src/craftsman-publication-repository.js";

const ownerId = "75000000-0000-4000-8000-000000000001" as UserId;
const otherId = "75000000-0000-4000-8000-000000000002" as UserId;
const profileId = "75000000-0000-4000-8000-000000000003" as CraftsmanProfileId;

describe("craftsman publication repository", () => {
  it("rejects malformed read identifiers before querying PostgreSQL", async () => {
    const sql = scriptedSql([]);
    await expect(
      createCraftsmanPublicationRepository(sql).findOwned({
        actorUserId: "malformed" as UserId,
        craftsmanProfileId: profileId,
      }),
    ).rejects.toThrow(/actorUserId/u);
    expect(sql.queries).toEqual([]);
  });

  it("fails closed before command replay for a suspended or non-owner actor", async () => {
    const sql = scriptedSql([[]]);
    await expect(
      createCraftsmanPublicationRepository(sql).submitForReview({
        actorUserId: otherId,
        commandId: "75000000-0000-4000-8000-000000000004",
        craftsmanProfileId: profileId,
        expectedRevision: 0,
      }),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
  });

  it("returns the precise private readiness checklist for an incomplete draft", async () => {
    const sql = scriptedSql([
      [{ id: profileId }],
      [],
      [
        publicationRow({
          missingRequirements: ["ABOUT", "NORMAL_RADIUS"],
        }),
      ],
    ]);
    await expect(
      createCraftsmanPublicationRepository(sql).submitForReview({
        actorUserId: ownerId,
        commandId: "75000000-0000-4000-8000-000000000005",
        craftsmanProfileId: profileId,
        expectedRevision: 0,
      }),
    ).resolves.toEqual({
      readiness: { isReady: false, missing: ["ABOUT", "NORMAL_RADIUS"] },
      status: "NOT_READY",
    });
  });

  it("stores owner preference independently and does not claim effective publication", async () => {
    const changed = publicationRow({
      changedAt: new Date("2026-09-14T12:00:00.000Z"),
      ownerVisibility: "PUBLIC",
      revision: 1,
    });
    const sql = scriptedSql([
      [{ id: profileId }],
      [],
      [publicationRow()],
      [],
      [],
      [changed],
    ]);
    await expect(
      createCraftsmanPublicationRepository(sql).setOwnerVisibility({
        actorUserId: ownerId,
        commandId: "75000000-0000-4000-8000-000000000006",
        craftsmanProfileId: profileId,
        expectedRevision: 0,
        visibility: "PUBLIC",
      }),
    ).resolves.toMatchObject({
      publication: {
        effectivelyPublic: false,
        ownerVisibility: "PUBLIC",
        reviewState: "DRAFT",
      },
      status: "APPLIED",
    });
  });

  it("rejects command-id reuse across actor, kind or payload", async () => {
    const sql = scriptedSql([
      [{ id: profileId }],
      [
        {
          actorKind: "OWNER",
          actorUserId: ownerId,
          commandKind: "SUBMIT_REVIEW",
          craftsmanProfileId: profileId,
          payloadFingerprint: "f".repeat(64),
          resultingRevision: 1,
        },
      ],
    ]);
    await expect(
      createCraftsmanPublicationRepository(sql).submitForReview({
        actorUserId: ownerId,
        commandId: "75000000-0000-4000-8000-000000000007",
        craftsmanProfileId: profileId,
        expectedRevision: 0,
      }),
    ).rejects.toThrow(CraftsmanPublicationIdempotencyError);
  });
});

interface ScriptedSql extends Sql {
  readonly queries: string[];
}

function scriptedSql(responses: readonly unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => work(tagged),
    queries,
  });
  return tagged;
}

function publicationRow(overrides: Record<string, unknown> = {}) {
  return { ...publicationRowBase(), ...overrides };
}

function publicationRowBase() {
  return {
    approvedAt: null,
    approvedByUserId: null,
    changedAt: null,
    craftsmanProfileId: profileId,
    effectivelyPublic: false,
    identityReviewReasonCode: null,
    identityReviewRuleReference: null,
    missingRequirements: [],
    moderatedAt: null,
    moderatedByUserId: null,
    moderationPolicyVersion: null,
    moderationReasonCategory: null,
    moderationReasonCode: null,
    moderationState: "ALLOWED" as const,
    ownerVisibility: "HIDDEN" as const,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReasonCode: null,
    rejectionUserFacingReason: null,
    reviewState: "DRAFT" as const,
    revision: 0,
  };
}
