import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";
import type {
  ConsentEventDraft,
  PrivacyPolicyVersionDraft,
  PrivacyRequestEventDraft,
  RetentionPolicyVersionDraft,
} from "@portal/privacy";

import { createPrivacyRepository } from "../src/index.js";

const userId = "10000000-0000-4000-8000-000000000001" as UserId;
const policyVersionId = "20000000-0000-4000-8000-000000000002";
const eventId = "30000000-0000-4000-8000-000000000003";
const correlationId = "40000000-0000-4000-8000-000000000004";
const caseId = "50000000-0000-4000-8000-000000000005";
const now = new Date("2026-09-14T12:00:00.000Z");

function fakeSql(responses: unknown[]) {
  const transaction = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      void strings;
      void values;
      return Promise.resolve(responses.shift() ?? []);
    },
  );
  const begin = vi.fn((operation: (sql: unknown) => unknown) =>
    operation(transaction),
  );
  const root = Object.assign(
    vi.fn(() => Promise.resolve(responses.shift() ?? [])),
    { begin },
  );
  return { begin, sql: root as unknown as Sql, transaction };
}

function consent(
  overrides: Partial<ConsentEventDraft> = {},
): ConsentEventDraft {
  return {
    action: "GRANTED",
    correlationId,
    eventId,
    expectedRevision: 0,
    policyVersionId,
    purpose: "MARKETING_EMAIL",
    subjectUserId: userId,
    ...overrides,
  };
}

const approvedMarketingPolicy = {
  effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
  optionalConsentPurpose: "MARKETING_EMAIL",
  policyKind: "OPTIONAL_CONSENT_TEXT",
  reviewState: "APPROVED",
};

describe("privacy repository consent boundaries", () => {
  it("rejects core processing disguised as optional consent before SQL", () => {
    const fixture = fakeSql([]);
    const repository = createPrivacyRepository(fixture.sql);
    expect(() =>
      repository.appendConsentEvent(
        consent({ purpose: "ACCOUNT_CREATION" as "MARKETING_EMAIL" }),
      ),
    ).toThrow(/not genuinely optional/u);
    expect(fixture.begin).not.toHaveBeenCalled();
  });

  it("rejects a consent text version bound to another purpose", async () => {
    const fixture = fakeSql([[], [], []]);
    const repository = createPrivacyRepository(fixture.sql);
    await expect(repository.appendConsentEvent(consent())).resolves.toEqual({
      status: "POLICY_NOT_APPROVED",
    });
    const policyQuery = fixture.transaction.mock.calls[2]?.[0];
    expect(policyQuery).toBeDefined();
    if (policyQuery === undefined) throw new Error("Policy query missing");
    expect(policyQuery.join("?")).toMatch(/optional_consent_purpose = \?/u);
  });

  it("requires the first event to be GRANTED and reports stale revisions", async () => {
    const firstWithdrawal = fakeSql([[], [], [approvedMarketingPolicy], []]);
    await expect(
      createPrivacyRepository(firstWithdrawal.sql).appendConsentEvent(
        consent({ action: "WITHDRAWN" }),
      ),
    ).resolves.toEqual({ currentRevision: 0, status: "UNCHANGED" });

    const current = {
      action: "GRANTED",
      correlationId,
      eventId,
      occurredAt: now,
      policyVersionId,
      purpose: "MARKETING_EMAIL",
      revision: 1,
      subjectUserId: userId,
    };
    const stale = fakeSql([[], [], [approvedMarketingPolicy], [current]]);
    await expect(
      createPrivacyRepository(stale.sql).appendConsentEvent(
        consent({
          action: "WITHDRAWN",
          eventId: "60000000-0000-4000-8000-000000000006",
          expectedRevision: 0,
        }),
      ),
    ).resolves.toEqual({ currentRevision: 1, status: "STALE" });
  });

  it("appends exactly current+1 under the transaction lock", async () => {
    const inserted = {
      action: "GRANTED",
      correlationId,
      eventId,
      occurredAt: now,
      policyVersionId,
      purpose: "MARKETING_EMAIL",
      revision: 1,
      subjectUserId: userId,
    };
    const fixture = fakeSql([
      [],
      [],
      [approvedMarketingPolicy],
      [],
      [inserted],
    ]);
    await expect(
      createPrivacyRepository(fixture.sql).appendConsentEvent(consent()),
    ).resolves.toEqual({ event: inserted, status: "APPENDED" });
    expect(fixture.transaction.mock.calls[0]![0].join("?")).toMatch(
      /pg_advisory_xact_lock/u,
    );
    expect(fixture.transaction.mock.calls[4]?.[7]).toBe(1);
  });

  it("rejects policy kind/purpose mismatch and unsafe retention defaults", () => {
    const fixture = fakeSql([]);
    const repository = createPrivacyRepository(fixture.sql);
    const policy = {
      contentSha256: "a".repeat(64),
      effectiveAt: now,
      optionalConsentPurpose: null,
      policyKind: "OPTIONAL_CONSENT_TEXT",
      policyVersionId,
      reviewState: "APPROVED",
      supersedesPolicyVersionId: null,
      versionLabel: "v1",
    } satisfies PrivacyPolicyVersionDraft;
    expect(() => repository.appendPolicyVersion(policy)).toThrow(
      /purpose are inconsistent/u,
    );

    const retention = {
      category: "APPLICATION_LOG",
      durationDays: 30,
      launchState: "READY",
      legalReviewState: "UNRESOLVED",
      policyVersionId,
      rationaleCode: "LEGAL_REVIEW_REQUIRED",
      supersedesPolicyVersionId: null,
      version: 1,
    } satisfies RetentionPolicyVersionDraft;
    expect(() => repository.appendRetentionPolicyVersion(retention)).toThrow(
      /not production-safe/u,
    );
    expect(fixture.begin).not.toHaveBeenCalled();
  });

  it("serializes retention heads and rejects branches or revision gaps", async () => {
    const firstInvalid = fakeSql([[], [], []]);
    await expect(
      createPrivacyRepository(firstInvalid.sql).appendRetentionPolicyVersion({
        category: "APPLICATION_LOG",
        durationDays: null,
        launchState: "BLOCKED",
        legalReviewState: "UNRESOLVED",
        policyVersionId,
        rationaleCode: "LEGAL_REVIEW_REQUIRED",
        supersedesPolicyVersionId: null,
        version: 2,
      }),
    ).rejects.toThrow(/extend the current category head contiguously/u);

    const currentId = "80000000-0000-4000-8000-000000000008";
    const current = {
      category: "APPLICATION_LOG" as const,
      createdAt: now,
      durationDays: null,
      launchState: "BLOCKED" as const,
      legalReviewState: "UNRESOLVED" as const,
      policyVersionId: currentId,
      rationaleCode: "LEGAL_REVIEW_REQUIRED",
      supersedesPolicyVersionId: null,
      version: 1,
    };
    const branch = fakeSql([[], [], [current]]);
    await expect(
      createPrivacyRepository(branch.sql).appendRetentionPolicyVersion({
        ...current,
        policyVersionId,
        supersedesPolicyVersionId: currentId,
        version: 3,
      }),
    ).rejects.toThrow(/extend the current category head contiguously/u);
    expect(branch.transaction.mock.calls[0]![0].join("?")).toMatch(
      /pg_advisory_xact_lock/u,
    );
  });
});

describe("privacy request history", () => {
  it("denies missing cases and invalid state jumps", async () => {
    const missing = fakeSql([[]]);
    const draft = {
      actionCode: "REQUEST_REVIEW_STARTED",
      actorUserId: userId,
      caseId,
      correlationId,
      deadlineAt: null,
      eventId,
      expectedRevision: 1,
      state: "IN_REVIEW",
    } satisfies PrivacyRequestEventDraft;
    await expect(
      createPrivacyRepository(missing.sql).appendPrivacyRequestEvent(draft),
    ).resolves.toEqual({ status: "CASE_NOT_FOUND" });

    const privacyCase = {
      caseId,
      receivedAt: now,
      requestType: "ACCESS",
      subjectUserId: userId,
    };
    const current = {
      actionCode: null,
      actorUserId: userId,
      caseId,
      correlationId,
      deadlineAt: null,
      eventId: "70000000-0000-4000-8000-000000000007",
      occurredAt: now,
      revision: 1,
      state: "RECEIVED",
      subjectUserId: userId,
    };
    const invalid = fakeSql([[privacyCase], [], [current]]);
    await expect(
      createPrivacyRepository(invalid.sql).appendPrivacyRequestEvent({
        ...draft,
        actionCode: "REQUEST_COMPLETED",
        state: "COMPLETED",
      }),
    ).resolves.toEqual({
      currentRevision: 1,
      status: "INVALID_TRANSITION",
    });
  });

  it("does not expose raw export/delete automation", () => {
    const repository = createPrivacyRepository(fakeSql([]).sql);
    expect(Object.keys(repository).sort()).toEqual([
      "appendConsentEvent",
      "appendPolicyVersion",
      "appendPrivacyRequestEvent",
      "appendRetentionPolicyVersion",
      "createPrivacyRequestCase",
      "findLatestRetentionPolicy",
    ]);
  });
});
