import { describe, expect, it, vi } from "vitest";

import {
  adminCredentialEvidenceHref,
  decideAdminCredentialClaim,
  isVerifiedCredentialState,
  loadAdminCredentialReviewQueue,
  parseAdminCredentialReviewPage,
} from "./admin-credential-review";

const claimId = "97000000-0000-4000-8000-000000000001";
const profileId = "97000000-0000-4000-8000-000000000002";
const professionId = "97000000-0000-4000-8000-000000000003";
const assetId = "97000000-0000-4000-8000-000000000004";
const commandId = "97000000-0000-4000-8000-000000000005";

const item = {
  claimId,
  createdAt: "2026-09-28T16:00:00.000Z",
  credentialTypeCode: "test.required-license",
  evidence: [
    {
      assetId,
      attachedAt: "2026-09-28T16:05:00.000Z",
      mediaKind: "DOCUMENT",
    },
  ],
  evidenceRequirement: "REQUIRED",
  expiresOn: "2028-09-28",
  profession: {
    code: "PROF:ELECTRICIAN",
    id: professionId,
    label: "Elektrikár",
  },
  profile: {
    id: profileId,
    primaryName: "Ján Novák",
    profileType: "INDIVIDUAL",
    secondaryName: "Jano",
  },
  revision: 2,
  state: "PENDING",
  updatedAt: "2026-09-28T16:05:00.000Z",
} as const;

describe("admin credential review client", () => {
  it("accepts only the exact privacy-minimal pending queue", () => {
    expect(
      parseAdminCredentialReviewPage({ items: [item], nextCursor: null }),
    ).toEqual({ items: [item], nextCursor: null });
    expect(
      parseAdminCredentialReviewPage({
        items: [{ ...item, storageKey: "private/credential.pdf" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseAdminCredentialReviewPage({
        items: [
          {
            ...item,
            evidence: [
              {
                ...item.evidence[0],
                signedUrl: "https://storage.example/private",
              },
            ],
          },
        ],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseAdminCredentialReviewPage({
        items: [{ ...item, state: "APPROVED" }],
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("loads the capability-gated queue without caching", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ items: [item], nextCursor: null }));

    await expect(
      loadAdminCredentialReviewQueue(undefined, fetcher),
    ).resolves.toEqual({
      page: { items: [item], nextCursor: null },
      status: "OK",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/admin/credential-claims/review-queue?limit=20",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("builds only the fixed same-origin evidence endpoint", () => {
    expect(adminCredentialEvidenceHref(claimId, assetId)).toBe(
      `/v1/admin/credential-claims/${claimId}/evidence/${assetId}`,
    );
    expect(
      adminCredentialEvidenceHref("https://evil.test", assetId),
    ).toBeNull();
    expect(adminCredentialEvidenceHref(claimId, "../storage-key")).toBeNull();
  });

  it("approves with CSRF and the exact optimistic command", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-admin-token" }))
      .mockResolvedValueOnce(
        Response.json({
          claim: {
            claimId,
            reviewReason: null,
            reviewReasonCategory: null,
            reviewedAt: "2026-09-28T17:00:00.000Z",
            revision: 3,
            state: "APPROVED",
          },
          status: "APPLIED",
        }),
      );

    await expect(
      decideAdminCredentialClaim({
        action: "approve",
        claimId,
        commandId,
        expectedRevision: 2,
        fetch: fetcher,
      }),
    ).resolves.toBe("OK");
    const [path, options] = fetcher.mock.calls[1] ?? [];
    expect(path).toBe(`/v1/admin/credential-claims/${claimId}/approve`);
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe(
      "csrf-admin-token",
    );
    expect(JSON.parse(options?.body as string)).toEqual({
      commandId,
      expectedRevision: 2,
    });
  });

  it("rejects with a category and fails closed on leaked response fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-admin-token" }))
      .mockResolvedValueOnce(
        Response.json({
          claim: {
            claimId,
            reviewReason: "Doklad nepreukazuje deklarované oprávnenie.",
            reviewReasonCategory: "INSUFFICIENT_EVIDENCE",
            reviewedAt: "2026-09-28T17:00:00.000Z",
            revision: 3,
            state: "REJECTED",
          },
          status: "DEDUPLICATED",
        }),
      );
    await expect(
      decideAdminCredentialClaim({
        action: "reject",
        claimId,
        commandId,
        expectedRevision: 2,
        fetch: fetcher,
        reason: "Doklad nepreukazuje deklarované oprávnenie.",
        reasonCategory: "INSUFFICIENT_EVIDENCE",
      }),
    ).resolves.toBe("OK");
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
      commandId,
      expectedRevision: 2,
      reason: "Doklad nepreukazuje deklarované oprávnenie.",
      reasonCategory: "INSUFFICIENT_EVIDENCE",
    });

    const leaked = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-admin-token" }))
      .mockResolvedValueOnce(
        Response.json({
          claim: {
            claimId,
            reviewReason: null,
            reviewReasonCategory: null,
            reviewedAt: "2026-09-28T17:00:00.000Z",
            revision: 3,
            state: "APPROVED",
            storageKey: "private/credential.pdf",
          },
          status: "APPLIED",
        }),
      );
    await expect(
      decideAdminCredentialClaim({
        action: "approve",
        claimId,
        commandId,
        expectedRevision: 2,
        fetch: leaked,
      }),
    ).resolves.toBe("UNAVAILABLE");
  });

  it("treats only approved credentials as verified", () => {
    expect(isVerifiedCredentialState("APPROVED")).toBe(true);
    expect(isVerifiedCredentialState("PENDING")).toBe(false);
    expect(isVerifiedCredentialState("REJECTED")).toBe(false);
    expect(isVerifiedCredentialState("REVOKED")).toBe(false);
  });
});
