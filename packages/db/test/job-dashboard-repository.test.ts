import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createJobDashboardRepository } from "../src/job-dashboard-repository.js";

const actorUserId = "86200000-0000-4000-8000-000000000001";
const jobId = "86200000-0000-4000-8000-000000000004";
const quoteId = "86200000-0000-4000-8000-000000000003";
const invitationId = "86200000-0000-4000-8000-000000000005";
const mediaAssetId = "86200000-0000-4000-8000-000000000006";
const eventA = "86200000-0000-4000-8000-000000000007";
const eventB = "86200000-0000-4000-8000-000000000008";
const acceptedAt = new Date("2026-09-16T18:00:00.000Z");

const row = {
  acceptedAt,
  customerOwnerUserId: actorUserId,
  id: jobId,
  providerDisplayName: "Testovací remeselník",
  quoteSnapshot: {
    authoringMode: "PLATFORM_STRUCTURED",
    commercialContent: {
      included_scope: ["Montáž"],
      price_mode: "FIXED",
      total_amount_cents: 100_000,
      vat_status: "VAT_INCLUDED",
      command_id: "must-never-leak",
    },
    pdfMediaAssetId: null,
    quoteId,
    revision: 1,
  },
  requestSnapshot: {
    contentRevision: 1,
    sections: {
      "request.core": {
        payload: {
          title: "Syntetická práca",
          description: "Montáž",
          primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
          relatedProfessionCodes: [],
          skillCodes: [],
          specializationCode: null,
        },
      },
      "request.location": {
        payload: { municipalityCode: "TEST:MUNICIPALITY_ALPHA" },
      },
      "request.timing": {
        payload: {
          mode: "SPECIFIC_PERIOD",
          startsOn: "2099-01-01",
          endsOn: "2099-01-10",
          completionDeadline: null,
        },
      },
      "request.budget": {
        payload: {
          currency: "EUR",
          mode: "UP_TO",
          minimumAmountCents: null,
          maximumAmountCents: 100_000,
        },
      },
      "request.details": {
        payload: {
          approximateQuantity: "2 miestnosti",
          customRequirements: null,
          materialResponsibility: "CRAFTSMAN_PROVIDES",
          siteInspection: "MAYBE",
        },
      },
    },
    visibleVersion: 1,
  },
  role: "CUSTOMER",
  state: "CONFIRMED",
  winningInvitationId: invitationId,
};

describe("primary-party Job dashboard repository", () => {
  it("lists only bounded, ACTIVE primary-party Jobs from immutable snapshots", async () => {
    const fixture = fakeSql([[row]]);
    const listed = await createJobDashboardRepository(
      fixture.sql,
    ).listForPrimaryParty({ actorUserId });
    expect(listed).toEqual([
      {
        acceptedAt,
        id: jobId,
        providerDisplayName: "Testovací remeselník",
        requestTitle: "Syntetická práca",
        role: "CUSTOMER",
        state: "CONFIRMED",
      },
    ]);
    expect(fixture.statements[0]).toContain("viewer.account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain(
      "customer.owner_user_id = viewer.id",
    );
    expect(fixture.statements[0]).toContain(
      "provider.owner_user_id = viewer.id",
    );
    expect(fixture.statements[0]).toContain("job_agreement_snapshots");
    expect(fixture.statements[0]).toContain("LIMIT 100");
  });

  it("reads the exact accepted agreement, documents and chronological timeline", async () => {
    const fixture = fakeSql([
      [row],
      [{ displayFilename: "dodatok.pdf", mediaAssetId }],
      [{ total: 1 }],
      [
        {
          eventId: eventA,
          eventType: "JOB_CONFIRMED",
          occurredAt: acceptedAt,
          actorRole: null,
          reason: null,
        },
        {
          eventId: eventB,
          eventType: "CONTACT_ADDRESS_UNLOCKED",
          occurredAt: acceptedAt,
          actorRole: null,
          reason: null,
        },
      ],
    ]);
    const detail = await createJobDashboardRepository(
      fixture.sql,
    ).readForPrimaryParty({ actorUserId, jobId });
    expect(detail).toMatchObject({
      id: jobId,
      quote: {
        commercialContent: {
          includedScope: ["Montáž"],
          priceMode: "FIXED",
          totalAmountCents: 100_000,
        },
        quoteId,
      },
      request: {
        description: "Montáž",
        scopeDetails: {
          primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
          timingMode: "SPECIFIC_PERIOD",
          maximumAmountCents: 100_000,
        },
        title: "Syntetická práca",
      },
      supportingDocuments: [
        {
          downloadPath: `/v1/media/${mediaAssetId}/download`,
          mediaAssetId,
        },
      ],
      winningInvitationId: invitationId,
    });
    expect(detail?.quote.commercialContent).not.toHaveProperty("commandId");
    expect(detail?.quote.commercialContent).not.toHaveProperty("command_id");
    expect(fixture.statements[1]).toContain(
      "job_quote_supporting_document_snapshots",
    );
    expect(fixture.statements[1]).toContain("canonical.revoked_at IS NULL");
    expect(fixture.statements[3]).toContain(
      "ORDER BY occurred_at, event_order",
    );
  });

  it("uses null for unknown/unauthorized and fails closed on corrupt evidence", async () => {
    const unknown = fakeSql([[]]);
    await expect(
      createJobDashboardRepository(unknown.sql).readForPrimaryParty({
        actorUserId,
        jobId,
      }),
    ).resolves.toBeNull();
    const invalid = fakeSql([]);
    await expect(
      createJobDashboardRepository(invalid.sql).readForPrimaryParty({
        actorUserId: "invalid",
        jobId,
      }),
    ).resolves.toBeNull();
    expect(invalid.statements).toHaveLength(0);
    const missingDocument = fakeSql([[row], [], [{ total: 1 }]]);
    await expect(
      createJobDashboardRepository(missingDocument.sql).readForPrimaryParty({
        actorUserId,
        jobId,
      }),
    ).rejects.toThrow("Accepted Job documents are unavailable");
    const corrupt = fakeSql([[{ ...row, state: "UNKNOWN" }]]);
    await expect(
      createJobDashboardRepository(corrupt.sql).readForPrimaryParty({
        actorUserId,
        jobId,
      }),
    ).rejects.toThrow("Invalid accepted Job read model");
  });

  it("gives an accepted request without an optional title a stable display label", async () => {
    const untitled = {
      ...row,
      requestSnapshot: {
        ...row.requestSnapshot,
        sections: {
          ...row.requestSnapshot.sections,
          "request.core": {
            payload: {
              ...row.requestSnapshot.sections["request.core"].payload,
              title: null,
            },
          },
        },
      },
    };
    const fixture = fakeSql([[untitled]]);
    const jobs = await createJobDashboardRepository(
      fixture.sql,
    ).listForPrimaryParty({
      actorUserId,
    });
    expect(jobs[0]?.requestTitle).toBe("Zákazka");
  });
});

function fakeSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const statements: string[] = [];
  let index = 0;
  const tagged = (parts: TemplateStringsArray): Promise<readonly unknown[]> => {
    statements.push(parts.join("?"));
    return Promise.resolve(responses[index++] ?? []);
  };
  const sql = Object.assign(tagged, {
    begin: (callback: (transaction: Sql) => Promise<unknown>) => callback(sql),
  }) as unknown as Sql;
  return { sql, statements };
}
