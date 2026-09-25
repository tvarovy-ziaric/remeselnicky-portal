import { randomUUID } from "node:crypto";

import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createPrivacySubjectExportRepository,
  PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION,
} from "../src/index.js";

const subjectUserId = randomUUID() as UserId;
const caseId = randomUUID();
const now = new Date("2026-09-25T09:00:00.000Z");

function fakeSql(responses: unknown[]) {
  const calls: string[] = [];
  const transaction = vi.fn((strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return Promise.resolve(responses.shift() ?? []);
  });
  const begin = vi.fn((operation: (sql: unknown) => unknown) =>
    operation(transaction),
  );
  return {
    begin,
    calls,
    sql: Object.assign(vi.fn(), { begin }) as unknown as Sql,
  };
}

function readyResponses(input?: { readonly drafts?: readonly unknown[] }) {
  return [
    [],
    [
      {
        caseId,
        requestType: "ACCESS",
        revision: 3,
        state: "IN_REVIEW",
      },
    ],
    [
      {
        accountState: "ACTIVE",
        accountStateChangedAt: now,
        adultAttestedAt: now,
        createdAt: now,
        email: "subject@example.test",
        emailVerifiedAt: now,
        phone: "+421900000000",
        phoneVerifiedAt: now,
        userId: subjectUserId,
      },
    ],
    [{ createdAt: now, profileId: randomUUID(), updatedAt: now }],
    [
      {
        about: "Moje služby",
        companyRegistrationNumber: null,
        companyRegistrationVerifiedAt: null,
        createdAt: now,
        identityVerifiedAt: now,
        nickname: "Majster",
        officialCompanyName: null,
        profileId: randomUUID(),
        profileType: "INDIVIDUAL",
        realFirstName: "Ján",
        realLastName: "Remeselník",
        revision: 2,
        updatedAt: now,
      },
    ],
    [
      {
        action: "GRANTED",
        occurredAt: now,
        policyVersionId: randomUUID(),
        purpose: "PORTFOLIO_PROPERTY_PHOTO_PUBLICATION",
        revision: 1,
      },
    ],
    [
      {
        actionCode: "IDENTITY_VERIFIED",
        caseId,
        deadlineAt: null,
        occurredAt: now,
        receivedAt: now,
        requestType: "ACCESS",
        revision: 2,
        state: "VERIFIED",
      },
    ],
    input?.drafts ?? [
      {
        jobRequestId: randomUUID(),
        payload: { description: "Moja požiadavka" },
        requestRevision: 2,
        savedAt: now,
        sectionKey: "request.details",
        sectionSchemaVersion: 1,
      },
    ],
    [
      {
        body: "Moja správa bez cudzej odpovede",
        conversationId: randomUUID(),
        createdAt: now,
        messageId: randomUUID(),
        sequence: "7",
      },
    ],
    [
      {
        byteSize: 1024,
        createdAt: now,
        declaredContentType: "image/jpeg",
        displayFilename: "foto.jpg",
        kind: "IMAGE",
        mediaAssetId: randomUUID(),
        ownerUserId: subjectUserId,
        provenanceEntityId: null,
        provenanceEntityRevision: null,
        provenanceEntityType: null,
        purpose: "PORTFOLIO_PHOTO",
        readyAt: now,
        rejectedAt: null,
        status: "READY",
        uploadedByUserId: subjectUserId,
      },
    ],
    [{ generatedAt: now }],
  ];
}

describe("privacy subject export repository", () => {
  it("builds a bounded explicit subject-only base bundle", async () => {
    const fixture = fakeSql(readyResponses());
    const result = await createPrivacySubjectExportRepository(
      fixture.sql,
    ).createForSubject({ caseId, subjectUserId });

    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("expected export");
    expect(result.document).toMatchObject({
      account: {
        email: "subject@example.test",
        phone: "+421900000000",
        userId: subjectUserId,
      },
      exportCase: {
        caseId,
        requestState: "IN_REVIEW",
        requestType: "ACCESS",
      },
      schemaVersion: "1.0",
      scope: { coverage: "BASE_BUNDLE_REQUIRES_CASE_REVIEW" },
      subjectAuthoredConversationMessages: [
        { body: "Moja správa bez cudzej odpovede", sequence: "7" },
      ],
    });
    expect(JSON.stringify(result.document)).not.toMatch(
      /password|sessionId|mfaFactor|storageKey|identityVerificationReference|actorUserId/iu,
    );
    expect(fixture.calls.join("\n")).not.toMatch(
      /password_hash|session_id_hash|storage_key|identity_verification_reference/iu,
    );
  });

  it("requires the exact subject-owned access or portability case and verified identity", async () => {
    const missing = fakeSql([[], []]);
    expect(
      await createPrivacySubjectExportRepository(missing.sql).createForSubject({
        caseId,
        subjectUserId,
      }),
    ).toEqual({ status: "NOT_FOUND" });

    const unverified = fakeSql([
      [],
      [
        {
          caseId,
          requestType: "PORTABILITY",
          revision: 1,
          state: "IDENTITY_VERIFICATION_PENDING",
        },
      ],
    ]);
    expect(
      await createPrivacySubjectExportRepository(
        unverified.sql,
      ).createForSubject({ caseId, subjectUserId }),
    ).toEqual({ status: "IDENTITY_VERIFICATION_REQUIRED" });
  });

  it("never silently truncates a large section", async () => {
    const draft = {
      jobRequestId: randomUUID(),
      payload: {},
      requestRevision: 1,
      savedAt: now,
      sectionKey: "request.details",
      sectionSchemaVersion: 1,
    };
    const fixture = fakeSql(
      readyResponses({
        drafts: Array.from(
          { length: PRIVACY_SUBJECT_EXPORT_MAX_ROWS_PER_SECTION + 1 },
          () => draft,
        ),
      }).slice(0, -1),
    );
    expect(
      await createPrivacySubjectExportRepository(fixture.sql).createForSubject({
        caseId,
        subjectUserId,
      }),
    ).toEqual({ status: "ASSISTED_EXPORT_REQUIRED" });
  });

  it("rejects malformed identifiers before opening a snapshot", async () => {
    const fixture = fakeSql([]);
    await expect(
      createPrivacySubjectExportRepository(fixture.sql).createForSubject({
        caseId: "not-an-id",
        subjectUserId,
      }),
    ).rejects.toThrow(TypeError);
    expect(fixture.begin).not.toHaveBeenCalled();
  });
});
