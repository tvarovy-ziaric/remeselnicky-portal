import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createJobContactRepository } from "../src/job-contact-repository.js";

const actorUserId = "12340000-0000-4000-8000-000000000001";
const jobId = "12340000-0000-4000-8000-000000000002";

describe("post-confirm Job contact projection", () => {
  it("returns current verified contacts and the accepted exact location only through the Job", async () => {
    const fixture = fakeSql([
      {
        customerEmail: "customer@portal.invalid",
        customerPhone: "+421900000001",
        jobId,
        locationPayload: {
          exactAddress: "Syntetická 1",
          mapPin: { latitude: 48.1, longitude: 17.1 },
          municipalityCode: "TEST:MUNICIPALITY_ALPHA",
          textClarification: "Vchod zo dvora",
        },
        locationRevision: 1,
        providerEmail: "provider@portal.invalid",
        providerPhone: "+421900000002",
      },
    ]);
    await expect(
      createJobContactRepository(fixture.sql).readForPrimaryParty({
        actorUserId,
        jobId,
      }),
    ).resolves.toEqual({
      customer: {
        email: "customer@portal.invalid",
        phone: "+421900000001",
      },
      jobId,
      locationRevision: 1,
      provider: {
        email: "provider@portal.invalid",
        phone: "+421900000002",
      },
      workLocation: {
        exactAddress: "Syntetická 1",
        mapPin: { latitude: 48.1, longitude: 17.1 },
        municipalityCode: "TEST:MUNICIPALITY_ALPHA",
        textClarification: "Vchod zo dvora",
      },
    });
    expect(fixture.statements[0]).toContain("viewer.account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain(
      "customer.owner_user_id = viewer.id",
    );
    expect(fixture.statements[0]).toContain(
      "provider.owner_user_id = viewer.id",
    );
    expect(fixture.statements[0]).toContain("job_agreement_snapshots");
    expect(fixture.statements[0]).toContain("job_acceptance_events");
    expect(fixture.statements[0]).toContain("CONTACT_ADDRESS_UNLOCKED");
    expect(fixture.statements[0]).toContain("current_job_locations");
  });

  it("fails closed on malformed identifiers or an invalid stored location", async () => {
    const invalidId = fakeSql([]);
    await expect(
      createJobContactRepository(invalidId.sql).readForPrimaryParty({
        actorUserId: "not-a-user",
        jobId,
      }),
    ).resolves.toBeNull();
    expect(invalidId.statements).toHaveLength(0);

    const invalidLocation = fakeSql([
      {
        customerEmail: "customer@portal.invalid",
        customerPhone: "+421900000001",
        jobId,
        locationPayload: {
          exactAddress: "Syntetická 1",
          mapPin: { latitude: 999, longitude: 17.1 },
          municipalityCode: "TEST:MUNICIPALITY_ALPHA",
        },
        locationRevision: 1,
        providerEmail: "provider@portal.invalid",
        providerPhone: "+421900000002",
      },
    ]);
    await expect(
      createJobContactRepository(invalidLocation.sql).readForPrimaryParty({
        actorUserId,
        jobId,
      }),
    ).resolves.toBeNull();
  });
});

function fakeSql(rows: readonly unknown[]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const statements: string[] = [];
  const sql = (parts: TemplateStringsArray): Promise<readonly unknown[]> => {
    statements.push(parts.join("?"));
    return Promise.resolve(rows);
  };
  return { sql: sql as unknown as Sql, statements };
}
