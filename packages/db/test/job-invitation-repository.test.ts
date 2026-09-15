import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import type {
  CraftsmanProfileId,
  JobInvitationId,
  JobRequestId,
  UserId,
} from "@portal/domain";

import { createJobInvitationRepository } from "../src/job-invitation-repository.js";

const customerActor = "9d000000-0000-4000-8000-000000000001" as UserId;
const craftsmanActor = "9d000000-0000-4000-8000-000000000002" as UserId;
const requestId = "9d000000-0000-4000-8000-000000000003" as JobRequestId;
const profileId = "9d000000-0000-4000-8000-000000000004" as CraftsmanProfileId;
const customerProfileId = "9d000000-0000-4000-8000-000000000005";
const invitationId = "9d000000-0000-4000-8000-000000000006" as JobInvitationId;
const commandId = "9d000000-0000-4000-8000-000000000007";
const now = new Date("2026-09-15T08:00:00Z");

describe("job invitation repository", () => {
  it("pins the current request versions and persists a pending invitation", async () => {
    const harness = transactionHarness([
      [{ customerProfileId }],
      [],
      [],
      [],
      [{ contentRevision: 4, visibleVersion: 3 }],
      [],
      [{}],
      [],
      [{ count: 0, limit: 5 }],
      [],
      [],
      [],
      [invitationRow("PENDING", 1)],
    ]);
    await expect(
      createJobInvitationRepository(harness.sql).sendOwned({
        actorUserId: customerActor,
        commandId,
        craftsmanProfileId: profileId,
        jobRequestId: requestId,
      }),
    ).resolves.toMatchObject({
      invitation: { requestContentRevision: 4, requestVisibleVersion: 3 },
      status: "APPLIED",
    });
    const statements = harness.statements.join("\n");
    expect(statements).toContain("current_job_request_active_content_versions");
    expect(statements).toContain("current_credential_qualification_policies");
    expect(statements).toContain("current.state IN ('PENDING', 'ENGAGED')");
  });

  it("fails closed before reading private data for an unverified actor", async () => {
    const harness = transactionHarness([[]]);
    await expect(
      createJobInvitationRepository(harness.sql).respondOwned({
        action: "ENGAGE",
        actorUserId: craftsmanActor,
        commandId,
        expectedRevision: 1,
        invitationId,
      }),
    ).resolves.toEqual({ status: "ACCOUNT_NOT_ELIGIBLE" });
    expect(harness.statements).toHaveLength(1);
    expect(harness.statements[0]).toContain("JOIN auth_credentials credential");
    expect(harness.statements[0]).toContain("phone_verified_at IS NOT NULL");
  });

  it("uses database expiry and refuses a late response", async () => {
    const harness = transactionHarness([
      [{}],
      [],
      [],
      [
        {
          craftsmanOwnerId: craftsmanActor,
          customerOwnerId: customerActor,
          databaseNow: new Date("2026-09-16T08:00:00Z"),
          expiresAt: new Date("2026-09-15T08:00:00Z"),
          revision: 1,
          state: "PENDING",
        },
      ],
    ]);
    await expect(
      createJobInvitationRepository(harness.sql).respondOwned({
        action: "ENGAGE",
        actorUserId: craftsmanActor,
        commandId,
        expectedRevision: 1,
        invitationId,
      }),
    ).resolves.toEqual({ status: "INVALID_TRANSITION" });
    expect(harness.statements.at(-1)).toContain("clock_timestamp()");
  });

  it("expires pending invitations with system-only commands", async () => {
    const harness = transactionHarness([
      [{ id: invitationId, revision: 1 }],
      [],
      [],
    ]);
    await expect(
      createJobInvitationRepository(harness.sql).expirePending(),
    ).resolves.toEqual([invitationId]);
    expect(harness.statements.join("\n")).toContain("system_initiated");
  });

  it("lists only invitations owned by an active actor", async () => {
    const harness = directHarness([
      [
        {
          changedAt: now,
          craftsmanDisplayName: "Majster Test",
          customerProfileId,
          expiresAt: new Date("2026-09-22T08:00:00Z"),
          id: invitationId,
          jobRequestId: requestId,
          perspective: "CUSTOMER",
          requestTitle: "Oprava strechy",
          revision: 1,
          state: "PENDING",
        },
      ],
    ]);
    await expect(
      createJobInvitationRepository(harness.sql).listOwned({
        actorUserId: customerActor,
        limit: 50,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        counterpartDisplayName: "Majster Test",
        perspective: "CUSTOMER",
        requestTitle: "Oprava strechy",
      }),
    ]);
    const statement = harness.statements.join("\n");
    expect(statement).toContain("actor.account_state = 'ACTIVE'");
    expect(statement).toContain("customer.owner_user_id = actor.id");
    expect(statement).toContain("craftsman.owner_user_id = actor.id");
    expect(statement).not.toContain("effectively_public");
  });

  it("reads the pinned brief while omitting exact location and contacts", async () => {
    const harness = transactionHarness([
      [{}],
      [
        {
          changedAt: now,
          craftsmanDisplayName: "Majster Test",
          customerProfileId,
          expiresAt: new Date("2026-09-22T08:00:00Z"),
          id: invitationId,
          jobRequestId: requestId,
          perspective: "CRAFTSMAN",
          requestContentRevision: 4,
          requestTitle: "Oprava strechy",
          requestVisibleVersion: 3,
          revision: 1,
          state: "PENDING",
        },
      ],
      [
        {
          payload: {
            description: "Výmena krytiny na prístrešku",
            primaryProfessionCode: "PROF:ROOFER",
            relatedProfessionCodes: [],
            skillCodes: [],
            specializationCode: null,
            title: "Hlavná 12",
          },
          sectionKey: "request.core",
          sectionSchemaVersion: 1,
        },
        {
          payload: {
            exactAddress: "Tajná 12",
            mapPin: { latitude: 48.14, longitude: 17.1 },
            municipalityCode: "SK0101528595",
            textClarification: "Okraj obce",
          },
          sectionKey: "request.location",
          sectionSchemaVersion: 1,
        },
        {
          payload: {
            approximateQuantity: "20 m2",
            customRequirements: "Adresa: Hlavná 12",
            materialResponsibility: "COMBINATION",
            siteInspection: "MAYBE",
          },
          sectionKey: "request.details",
          sectionSchemaVersion: 1,
        },
      ],
      [{ approximateDistanceKm: 12 }],
    ]);
    const detail = await createJobInvitationRepository(harness.sql).readOwned({
      actorUserId: craftsmanActor,
      invitationId,
    });
    expect(detail).toMatchObject({
      counterpartDisplayName: `Zákazník ${customerProfileId.slice(0, 8).toUpperCase()}`,
      perspective: "CRAFTSMAN",
      request: {
        approximateDistanceKm: 12,
        description: "Výmena krytiny na prístrešku",
        details: { customRequirements: null },
        municipalityCode: "SK0101528595",
        title: "Dopyt",
      },
      requestContentRevision: 4,
      requestVisibleVersion: 3,
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("exactAddress");
    expect(serialized).not.toContain("mapPin");
    expect(serialized).not.toContain("Tajná 12");
    expect(serialized).not.toContain("Hlavná 12");
    expect(harness.statements[0]).toContain("account_state = 'ACTIVE'");
    expect(harness.statements[1]).toContain("FOR UPDATE OF invitation");
    expect(harness.statements[1]).toContain("actor.account_state = 'ACTIVE'");
    expect(harness.statements.join("\n")).not.toContain("effectively_public");
  });

  it("returns no private detail for a foreign or suspended actor", async () => {
    const harness = transactionHarness([[]]);
    await expect(
      createJobInvitationRepository(harness.sql).readOwned({
        actorUserId: craftsmanActor,
        invitationId,
      }),
    ).resolves.toBeNull();
    expect(harness.statements).toHaveLength(1);
  });
});

function invitationRow(state: "PENDING", revision: number) {
  return {
    changedAt: now,
    craftsmanProfileId: profileId,
    customerProfileId,
    declineNote: null,
    declineReason: null,
    engagedAt: null,
    expiresAt: new Date("2026-09-22T08:00:00Z"),
    id: invitationId,
    jobRequestId: requestId,
    requestContentRevision: 4,
    requestVisibleVersion: 3,
    revision,
    sentAt: now,
    state,
  };
}

function transactionHarness(responses: readonly unknown[][]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const queue = [...responses];
  const statements: string[] = [];
  const transaction = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return Promise.resolve(queue.shift() ?? []);
    }),
    { json: (value: unknown) => value },
  ) as unknown as Sql;
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn((work: (transaction: Sql) => Promise<unknown>) =>
      work(transaction),
    ),
  }) as unknown as Sql;
  return { sql, statements };
}

function directHarness(responses: readonly unknown[][]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const queue = [...responses];
  const statements: string[] = [];
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return Promise.resolve(queue.shift() ?? []);
    }),
    {
      begin: vi.fn(),
      json: (value: unknown) => value,
    },
  ) as unknown as Sql;
  return { sql, statements };
}
