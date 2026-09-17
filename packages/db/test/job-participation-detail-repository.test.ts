import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createJobParticipationDetailRepository } from "../src/job-participation-detail-repository.js";

const actorUserId = "86200000-0000-4000-8000-000000000001";
const participantId = "86200000-0000-4000-8000-000000000002";
const jobId = "86200000-0000-4000-8000-000000000003";
const profileId = "86200000-0000-4000-8000-000000000004";
const providerProfileId = "86200000-0000-4000-8000-000000000005";
const invitedAt = new Date("2026-09-16T08:00:00.000Z");
const acceptedAt = new Date("2026-09-16T09:00:00.000Z");

function fakeSql(rows: readonly unknown[]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const statements: string[] = [];
  const tagged = (parts: TemplateStringsArray): Promise<readonly unknown[]> => {
    statements.push(parts.join("?"));
    return Promise.resolve(rows);
  };
  return { sql: tagged as unknown as Sql, statements };
}

const row = {
  participantId,
  jobId,
  participantProfileId: profileId,
  providerProfileId,
  viewerRole: "PARTICIPANT",
  state: "INVITED",
  jobState: "CONFIRMED",
  participantDisplayName: "Pomocník",
  providerDisplayName: "Majster",
  municipalityName: "Bratislava",
  primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
  invitedAt,
  acceptedAt: null,
  leftAt: null,
};

describe("exact Job participation detail", () => {
  it("rejects malformed IDs before querying", async () => {
    const fixture = fakeSql([]);
    await expect(
      createJobParticipationDetailRepository(fixture.sql).getForViewer({
        actorUserId,
        participantId: "bad",
      }),
    ).rejects.toThrow(TypeError);
    expect(fixture.statements).toEqual([]);
  });

  it("returns no detail for an unrelated or inactive viewer", async () => {
    const fixture = fakeSql([]);
    await expect(
      createJobParticipationDetailRepository(fixture.sql).getForViewer({
        actorUserId,
        participantId,
      }),
    ).resolves.toBeNull();
    expect(fixture.statements[0]).toContain("viewer.account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain(
      "participant.accepted_at IS NOT NULL",
    );
    expect(fixture.statements[0]).not.toContain("exact_address");
  });

  it("allows only the invitee to decide a pending invitation", async () => {
    const fixture = fakeSql([row]);
    const result = await createJobParticipationDetailRepository(
      fixture.sql,
    ).getForViewer({ actorUserId, participantId });
    expect(result).toMatchObject({
      viewerRole: "PARTICIPANT",
      state: "INVITED",
      canDecide: true,
      canLeave: false,
    });
    expect(result).not.toHaveProperty("exactAddress");
    expect(result).not.toHaveProperty("customerContact");
  });

  it("preserves history but disables actions after cancellation", async () => {
    const fixture = fakeSql([
      {
        ...row,
        viewerRole: "CUSTOMER",
        state: "LEFT",
        jobState: "CANCELLED",
        acceptedAt,
        leftAt: new Date("2026-09-16T12:00:00.000Z"),
      },
    ]);
    const result = await createJobParticipationDetailRepository(
      fixture.sql,
    ).getForViewer({ actorUserId, participantId });
    expect(result).toMatchObject({
      viewerRole: "CUSTOMER",
      state: "LEFT",
      jobState: "CANCELLED",
      canDecide: false,
      canLeave: false,
    });
  });

  it("fails closed if a pending participant is projected as customer-visible", async () => {
    const fixture = fakeSql([{ ...row, viewerRole: "CUSTOMER" }]);
    await expect(
      createJobParticipationDetailRepository(fixture.sql).getForViewer({
        actorUserId,
        participantId,
      }),
    ).rejects.toThrow("Invalid Job participation detail provenance");
  });
});
