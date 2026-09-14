import { createHash } from "node:crypto";

import type { AdminAccessService, PrivilegedActor } from "@portal/admin-auth";
import type {
  CreateCredentialClaimInput,
  CredentialClaimId,
  CraftsmanProfessionId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createCredentialClaimRepository,
  createCredentialReviewService,
  CredentialClaimIdempotencyError,
} from "../src/credential-claim-repository.js";

const actorUserId = "60000000-0000-4000-8000-000000000001" as UserId;
const adminUserId = "60000000-0000-4000-8000-000000000002" as UserId;
const craftsmanProfileId =
  "60000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const craftsmanProfessionId =
  "60000000-0000-4000-8000-000000000004" as CraftsmanProfessionId;
const claimId = "60000000-0000-4000-8000-000000000005" as CredentialClaimId;
const commandId = "60000000-0000-4000-8000-000000000006";

describe("credential claim repository", () => {
  it("creates a pending explicit profession/type claim", async () => {
    const sql = scriptedSql([
      [{ ownerUserId: actorUserId }],
      [],
      [{ id: craftsmanProfessionId }],
      [{ code: "sk.electrical" }],
      [],
      [],
      [],
      [],
      [claimRow()],
      [],
    ]);
    await expect(
      createCredentialClaimRepository(sql).create(createInput()),
    ).resolves.toMatchObject({
      claim: {
        credentialTypeCode: "sk.electrical",
        evidenceRequirement: "REQUIRED",
        evidence: [],
        state: "PENDING",
      },
      status: "APPLIED",
    });
    expect(sql.queries.join("\n")).toMatch(
      /INSERT INTO credential_claims[\s\S]*INSERT INTO credential_claim_commands[\s\S]*INSERT INTO credential_claim_revisions/u,
    );
  });

  it("rechecks ACTIVE ownership before replay and allowlists the snapshot", async () => {
    const input = createInput();
    const replay = {
      ...claimRow(),
      actorUserId,
      commandKind: "CREATE",
      commandProfileId: craftsmanProfileId,
      payloadFingerprint: fingerprint("CREATE", input),
    };
    const sql = scriptedSql([[{ ownerUserId: actorUserId }], [replay], []]);
    const result = await createCredentialClaimRepository(sql).create(input);
    expect(result).toMatchObject({ status: "DEDUPLICATED" });
    if (!("claim" in result)) throw new Error("Expected replay claim.");
    expect(result.claim).not.toHaveProperty("payloadFingerprint");
    expect(result.claim).not.toHaveProperty("actorUserId");

    const suspended = scriptedSql([[]]);
    await expect(
      createCredentialClaimRepository(suspended).create(input),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(suspended.queries).toHaveLength(1);
  });

  it("denies review before repository access when capability/MFA authorization fails", async () => {
    const authorize = vi.fn(() =>
      Promise.resolve({ status: "MFA_TOO_OLD" as const }),
    );
    const reviewAuthorized = vi.fn();
    const repository = {
      listPendingAuthorized: vi.fn(),
      reviewAuthorized,
    } as unknown as ReturnType<typeof createCredentialClaimRepository>;
    const service = createCredentialReviewService({
      adminAccess: { authorize } as unknown as AdminAccessService,
      repository,
    });
    await expect(
      service.review({
        actorUserId: adminUserId,
        command: {
          claimId,
          commandId,
          decision: "APPROVE",
          expectedRevision: 1,
        },
        privilegedSessionId: "opaque-privileged-session",
      }),
    ).resolves.toEqual({ status: "AUTHORIZATION_DENIED" });
    expect(reviewAuthorized).not.toHaveBeenCalled();
  });

  it("locks the full live authorization chain for an admin queue read", async () => {
    const sql = scriptedSql([[{ valid: true }], [claimRow()], []]);
    await expect(
      createCredentialClaimRepository(sql).listPendingAuthorized({
        actor: privilegedActor(),
        privilegedSessionIdHash: "a".repeat(64),
      }),
    ).resolves.toHaveLength(1);
    expect(sql.queries[0]).toMatch(
      /FOR UPDATE OF privileged, base, actor, factor, role/u,
    );
    expect(sql.queries[1]).toMatch(/claim\.state = 'PENDING'/u);
  });

  it("mints trusted credential upload provenance only from current owned pending state", async () => {
    const sql = scriptedSql([[{ ownerUserId: actorUserId }], [claimRow()]]);
    await expect(
      createCredentialClaimRepository(sql).prepareEvidenceUpload({
        actorUserId,
        claimId,
        craftsmanProfileId,
        expectedRevision: 1,
        mediaKind: "IMAGE",
      }),
    ).resolves.toMatchObject({
      provenance: {
        entityId: claimId,
        entityRevision: 1,
        entityType: "CREDENTIAL",
      },
      purpose: "CREDENTIAL_IMAGE",
      status: "READY",
    });
    expect(sql.queries[1]).toMatch(/FOR UPDATE/u);

    const nonOwner = scriptedSql([[]]);
    await expect(
      createCredentialClaimRepository(nonOwner).prepareEvidenceUpload({
        actorUserId,
        claimId,
        craftsmanProfileId,
        expectedRevision: 1,
        mediaKind: "DOCUMENT",
      }),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });

    const stale = scriptedSql([[{ ownerUserId: actorUserId }], [claimRow()]]);
    await expect(
      createCredentialClaimRepository(stale).prepareEvidenceUpload({
        actorUserId,
        claimId,
        craftsmanProfileId,
        expectedRevision: 2,
        mediaKind: "DOCUMENT",
      }),
    ).resolves.toEqual({ status: "STALE_REVISION" });

    const notPending = scriptedSql([
      [{ ownerUserId: actorUserId }],
      [claimRow({ state: "APPROVED" })],
    ]);
    await expect(
      createCredentialClaimRepository(notPending).prepareEvidenceUpload({
        actorUserId,
        claimId,
        craftsmanProfileId,
        expectedRevision: 1,
        mediaKind: "DOCUMENT",
      }),
    ).resolves.toEqual({ status: "CLAIM_NOT_PENDING" });
  });

  it("fails required approval when no current READY private evidence remains", async () => {
    const sql = scriptedSql([[{ valid: true }], [claimRow()], [], []]);
    await expect(
      createCredentialClaimRepository(sql).reviewAuthorized({
        actor: privilegedActor(),
        command: {
          claimId,
          commandId,
          decision: "APPROVE",
          expectedRevision: 1,
        },
        privilegedSessionIdHash: "a".repeat(64),
      }),
    ).resolves.toEqual({ status: "REQUIRED_EVIDENCE_MISSING" });
    expect(sql.queries.at(-1)).toMatch(/object\.revoked_at IS NULL/u);
  });

  it("writes a manual decision, immutable revision and minimized audit in one transaction", async () => {
    const approved = claimRow({
      evidenceRequirement: "OPTIONAL",
      revision: 2,
      state: "APPROVED",
    });
    const sql = scriptedSql([
      [{ valid: true }],
      [claimRow({ evidenceRequirement: "OPTIONAL" })],
      [],
      [],
      [],
      [],
      [],
      [auditRow()],
      [approved],
      [],
    ]);
    await expect(
      createCredentialClaimRepository(sql).reviewAuthorized({
        actor: privilegedActor(),
        command: {
          claimId,
          commandId,
          decision: "APPROVE",
          expectedRevision: 1,
        },
        privilegedSessionIdHash: "a".repeat(64),
      }),
    ).resolves.toMatchObject({
      claim: { revision: 2, state: "APPROVED" },
      status: "APPLIED",
    });
    expect(sql.queries.join("\n")).toMatch(
      /INSERT INTO credential_claim_decisions[\s\S]*INSERT INTO credential_claim_revisions[\s\S]*INSERT INTO audit_events/u,
    );
  });

  it("reauthorizes exact review replay and returns only the original allowlisted snapshot", async () => {
    const actor = privilegedActor();
    const command = {
      claimId,
      commandId,
      decision: "APPROVE" as const,
      expectedRevision: 1,
    };
    const replay = {
      ...claimRow({ revision: 2, state: "APPROVED" }),
      actorUserId: adminUserId,
      commandKind: "APPROVE",
      commandProfileId: craftsmanProfileId,
      payloadFingerprint: fingerprint("APPROVE", {
        ...command,
        actorUserId: adminUserId,
      }),
    };
    const sql = scriptedSql([[{ valid: true }], [claimRow()], [replay], []]);
    const result = await createCredentialClaimRepository(sql).reviewAuthorized({
      actor,
      command,
      privilegedSessionIdHash: "a".repeat(64),
    });
    expect(result).toMatchObject({
      claim: { revision: 2 },
      status: "DEDUPLICATED",
    });
    if (!("claim" in result)) throw new Error("Expected review replay.");
    expect(result.claim).not.toHaveProperty("actorUserId");
    expect(result.claim).not.toHaveProperty("payloadFingerprint");

    const denied = scriptedSql([[]]);
    await expect(
      createCredentialClaimRepository(denied).reviewAuthorized({
        actor,
        command,
        privilegedSessionIdHash: "b".repeat(64),
      }),
    ).resolves.toEqual({ status: "CLAIM_UNAVAILABLE" });
    expect(denied.queries).toHaveLength(1);
  });

  it("rejects review command-id reuse across actor or fingerprint", async () => {
    const command = {
      claimId,
      commandId,
      decision: "APPROVE" as const,
      expectedRevision: 1,
    };
    const baseReplay = {
      ...claimRow({ revision: 2, state: "APPROVED" }),
      actorUserId: adminUserId,
      commandKind: "APPROVE",
      commandProfileId: craftsmanProfileId,
      payloadFingerprint: fingerprint("APPROVE", {
        ...command,
        actorUserId: adminUserId,
      }),
    };
    for (const replay of [
      { ...baseReplay, actorUserId },
      { ...baseReplay, payloadFingerprint: "f".repeat(64) },
    ]) {
      const sql = scriptedSql([[{ valid: true }], [claimRow()], [replay]]);
      await expect(
        createCredentialClaimRepository(sql).reviewAuthorized({
          actor: privilegedActor(),
          command,
          privilegedSessionIdHash: "a".repeat(64),
        }),
      ).rejects.toThrow(CredentialClaimIdempotencyError);
    }
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
    json: (value: unknown) => value,
    queries,
  });
  return tagged;
}

function createInput(): CreateCredentialClaimInput {
  return {
    actorUserId,
    claimId,
    commandId,
    craftsmanProfessionId,
    craftsmanProfileId,
    credentialTypeCode: "sk.electrical",
    expiresOn: null,
  };
}

function claimRow(overrides: Partial<ReturnType<typeof baseClaimRow>> = {}) {
  return { ...baseClaimRow(), ...overrides };
}

function baseClaimRow() {
  return {
    craftsmanProfessionId,
    craftsmanProfileId,
    createdAt: new Date("2026-09-14T10:00:00.000Z"),
    credentialTypeCode: "sk.electrical",
    evidenceRequirement: "REQUIRED",
    expiresOn: null,
    id: claimId,
    reviewReason: null,
    reviewReasonCategory: null,
    reviewedAt: null,
    revision: 1 as number,
    state: "PENDING" as "PENDING" | "APPROVED" | "REJECTED" | "REVOKED",
    updatedAt: new Date("2026-09-14T10:00:00.000Z"),
  };
}

function privilegedActor(): PrivilegedActor {
  return {
    capabilities: new Set(["admin.credentials.review"]),
    mfaAuthenticatedAt: new Date("2026-09-14T10:00:00.000Z"),
    roles: ["ADMIN"],
    userId: adminUserId,
  };
}

function auditRow() {
  return {
    action: "admin.credential.approved",
    actorCapability: "admin.credentials.review",
    actorKind: "AUTHENTICATED_USER",
    actorSystemReference: null,
    actorUserId: adminUserId,
    category: "PRIVILEGED_COMMAND",
    changes: {
      credential_state: { after: "APPROVED", before: "PENDING" },
    },
    contextId: null,
    contextType: null,
    correlationId: commandId,
    eventId: "60000000-0000-5000-a000-000000000007",
    occurredAt: new Date("2026-09-14T10:01:00.000Z"),
    reason: "Credential claim approved after manual review.",
    sensitiveAccessPurpose: null,
    targetId: claimId,
    targetType: "CREDENTIAL_CLAIM",
  } as const;
}

function fingerprint(kind: string, input: object): string {
  const value = input as Record<string, unknown>;
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        value.commandId,
        value.claimId,
        value.craftsmanProfileId ?? null,
        value.actorUserId,
        value.expectedRevision ?? 0,
        value.craftsmanProfessionId ?? null,
        value.credentialTypeCode ?? null,
        value.expiresOn ?? null,
        value.mediaAssetId ?? null,
        value.decision ?? null,
        value.reasonCategory ?? null,
        value.reason ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}
