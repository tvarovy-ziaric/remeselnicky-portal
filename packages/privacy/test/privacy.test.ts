import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createPrivacyService,
  defineDataFieldClassification,
  requireExecutableRetentionPolicy,
  RetentionPolicyUnresolvedError,
  type ConsentEvent,
  type PrivacyRepository,
  type RetentionPolicyVersion,
} from "../src/index.js";

const userId = "10000000-0000-4000-8000-000000000001" as UserId;
const eventId = "20000000-0000-4000-8000-000000000002";
const correlationId = "30000000-0000-4000-8000-000000000003";
const policyVersionId = "40000000-0000-4000-8000-000000000004";
const occurredAt = new Date("2026-09-14T12:00:00.000Z");

describe("data classification", () => {
  it("defaults every field to PRIVATE", () => {
    expect(
      defineDataFieldClassification({
        field: "customer.phone",
        purposeCode: "account.transactional_contact",
      }),
    ).toEqual({
      classification: "PRIVATE",
      field: "customer.phone",
      publicProjection: false,
      purposeCode: "account.transactional_contact",
    });
  });

  it("requires an explicit public projection for PUBLIC data", () => {
    expect(() =>
      defineDataFieldClassification({
        classification: "PUBLIC",
        field: "craftsman.display_name",
        purposeCode: "profile.discovery",
      }),
    ).toThrow(/must agree/u);
    expect(
      defineDataFieldClassification({
        classification: "PUBLIC",
        field: "craftsman.display_name",
        publicProjection: true,
        purposeCode: "profile.discovery",
      }),
    ).toMatchObject({ classification: "PUBLIC", publicProjection: true });
  });

  it("bounds field and purpose taxonomy codes", () => {
    expect(() =>
      defineDataFieldClassification({
        field: `a${"b".repeat(64)}`,
        purposeCode: "profile.discovery",
      }),
    ).toThrow(/bounded taxonomy codes/u);
    expect(() =>
      defineDataFieldClassification({
        field: "craftsman.display_name",
        purposeCode: `a${"b".repeat(96)}`,
      }),
    ).toThrow(/bounded taxonomy codes/u);
  });
});

function retention(
  overrides: Partial<RetentionPolicyVersion> = {},
): RetentionPolicyVersion {
  return {
    category: "APPLICATION_LOG",
    createdAt: occurredAt,
    durationDays: null,
    launchState: "BLOCKED",
    legalReviewState: "UNRESOLVED",
    policyVersionId,
    rationaleCode: "LEGAL_REVIEW_REQUIRED",
    supersedesPolicyVersionId: null,
    version: 1,
    ...overrides,
  };
}

describe("retention execution gate", () => {
  it.each([
    null,
    retention(),
    retention({
      durationDays: 30,
      legalReviewState: "APPROVED",
      launchState: "BLOCKED",
    }),
  ])(
    "fails closed for absent or unresolved launch/legal policy",
    async (value) => {
      await expect(
        requireExecutableRetentionPolicy(
          { findLatestRetentionPolicy: () => Promise.resolve(value) },
          "APPLICATION_LOG",
        ),
      ).rejects.toBeInstanceOf(RetentionPolicyUnresolvedError);
    },
  );

  it("returns only a concrete legally approved READY duration", async () => {
    const policy = retention({
      durationDays: 30,
      launchState: "READY",
      legalReviewState: "APPROVED",
      version: 2,
    });
    await expect(
      requireExecutableRetentionPolicy(
        { findLatestRetentionPolicy: () => Promise.resolve(policy) },
        "APPLICATION_LOG",
      ),
    ).resolves.toEqual(policy);
  });
});

describe("privacy audit projection", () => {
  const consent: ConsentEvent = {
    action: "GRANTED",
    correlationId,
    eventId,
    occurredAt,
    policyVersionId,
    purpose: "MARKETING_EMAIL",
    revision: 1,
    subjectUserId: userId,
  };

  it("projects only minimized identifiers after authoritative persistence", async () => {
    const order: string[] = [];
    const project = vi.fn(() => {
      order.push("audit");
      return Promise.resolve();
    });
    const repository = {
      appendConsentEvent: vi.fn(() => {
        order.push("repository");
        return Promise.resolve({ event: consent, status: "APPENDED" as const });
      }),
    } as unknown as PrivacyRepository;
    const result = await createPrivacyService({
      audit: { project },
      repository,
    }).recordConsent({
      action: "GRANTED",
      correlationId,
      eventId,
      expectedRevision: 0,
      policyVersionId,
      purpose: "MARKETING_EMAIL",
      subjectUserId: userId,
    });

    expect(result.status).toBe("APPENDED");
    expect(order).toEqual(["repository", "audit"]);
    expect(project).toHaveBeenCalledWith({
      action: "privacy.consent.granted",
      actorUserId: userId,
      correlationId,
      eventId,
      outcome: "MARKETING_EMAIL",
      subjectUserId: userId,
      targetId: eventId,
      targetType: "CONSENT",
    });
    expect(JSON.stringify(project.mock.calls)).not.toMatch(
      /email@|request body|document|address/iu,
    );
  });

  it("keeps privacy history authoritative when audit projection needs retry", async () => {
    const appendConsentEvent = vi
      .fn()
      .mockResolvedValueOnce({ event: consent, status: "APPENDED" as const })
      .mockResolvedValueOnce({
        event: consent,
        status: "DEDUPLICATED" as const,
      });
    const project = vi
      .fn()
      .mockRejectedValueOnce(new Error("audit temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = createPrivacyService({
      audit: { project },
      repository: { appendConsentEvent } as unknown as PrivacyRepository,
    });
    const command = {
      action: "GRANTED" as const,
      correlationId,
      eventId,
      expectedRevision: 0,
      policyVersionId,
      purpose: "MARKETING_EMAIL" as const,
      subjectUserId: userId,
    };

    await expect(service.recordConsent(command)).rejects.toThrow(
      /audit temporarily unavailable/u,
    );
    await expect(service.recordConsent(command)).resolves.toMatchObject({
      status: "DEDUPLICATED",
    });
    expect(appendConsentEvent).toHaveBeenCalledTimes(2);
    expect(project).toHaveBeenCalledTimes(2);
  });
});
