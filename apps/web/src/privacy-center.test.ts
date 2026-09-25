import { describe, expect, it } from "vitest";

import {
  parseClosureReadiness,
  parsePrivacyRequests,
  privacyExportHref,
} from "./privacy-center.js";

describe("privacy center response validation", () => {
  it("accepts only the minimized subject-facing request projection", () => {
    expect(
      parsePrivacyRequests({
        items: [
          {
            actionCode: "REQUEST_RECEIVED",
            caseId: "72000000-0000-4000-8000-000000000001",
            deadlineAt: null,
            occurredAt: "2026-09-25T08:00:00.000Z",
            receivedAt: "2026-09-25T08:00:00.000Z",
            requestType: "ACCOUNT_CLOSURE",
            revision: 1,
            state: "RECEIVED",
          },
        ],
      }),
    ).toHaveLength(1);
    expect(
      parseClosureReadiness({
        canRequestClosure: true,
        executionBlockedByOpenObligations: true,
      }),
    ).toEqual({
      canRequestClosure: true,
      executionBlockedByOpenObligations: true,
    });
  });

  it("rejects malformed states, hidden evidence fields and ambiguous readiness", () => {
    const base = {
      actionCode: null,
      caseId: "72000000-0000-4000-8000-000000000001",
      deadlineAt: null,
      occurredAt: "2026-09-25T08:00:00.000Z",
      receivedAt: "2026-09-25T08:00:00.000Z",
      requestType: "ACCESS",
      revision: 1,
      state: "RECEIVED",
    };
    expect(
      parsePrivacyRequests({ items: [{ ...base, state: "AUTO_APPROVED" }] }),
    ).toBeNull();
    expect(
      parsePrivacyRequests({
        items: [{ ...base, identityEvidence: "must not be projected" }],
      }),
    ).toBeNull();
    expect(
      parseClosureReadiness({
        canRequestClosure: true,
        executionBlockedByOpenObligations: false,
        eraseImmediately: true,
      }),
    ).toBeNull();
  });

  it("offers the base export only for a verified access or portability case", () => {
    const base = {
      actionCode: "IDENTITY_VERIFIED",
      caseId: "72000000-0000-4000-8000-000000000001",
      deadlineAt: null,
      occurredAt: "2026-09-25T08:00:00.000Z",
      receivedAt: "2026-09-25T08:00:00.000Z",
      requestType: "ACCESS" as const,
      revision: 2,
      state: "VERIFIED" as const,
    };
    expect(privacyExportHref(base)).toBe(
      "/v1/me/privacy/requests/72000000-0000-4000-8000-000000000001/export",
    );
    expect(
      privacyExportHref({ ...base, state: "IDENTITY_VERIFICATION_PENDING" }),
    ).toBeNull();
    expect(
      privacyExportHref({
        ...base,
        requestType: "ERASURE",
        state: "IN_REVIEW",
      }),
    ).toBeNull();
  });
});
