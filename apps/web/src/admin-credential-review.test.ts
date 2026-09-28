import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AdminCredentialReviewDetail,
  AdminCredentialReviewWorkspace,
  adminCredentialEvidenceHref,
  appendAdminCredentialReviewPage,
  credentialDecisionCommandId,
  decideAdminCredentialClaim,
  isVerifiedCredentialState,
  loadAdminCredentialReviewHistory,
  loadAdminCredentialReviewQueue,
  parseAdminCredentialReviewHistoryPage,
  parseAdminCredentialReviewPage,
  settleCredentialDecisionAttempt,
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

const approvedItem = {
  ...item,
  reviewReasonCategory: null,
  reviewReason: null,
  reviewedAt: "2026-09-28T17:00:00.000Z",
  revision: 3,
  state: "APPROVED",
  updatedAt: "2026-09-28T17:00:00.000Z",
} as const;

const rejectedItem = {
  ...item,
  reviewReasonCategory: "INSUFFICIENT_EVIDENCE",
  reviewReason: "Doklad nepreukazuje deklarované oprávnenie.",
  reviewedAt: "2026-09-28T17:00:00.000Z",
  revision: 3,
  state: "REJECTED",
  updatedAt: "2026-09-28T17:00:00.000Z",
} as const;

describe("admin credential review client", () => {
  it("offers all four credential review views", () => {
    const workspace = renderToStaticMarkup(
      createElement(AdminCredentialReviewWorkspace),
    );
    expect(workspace).toContain("Čakajúce");
    expect(workspace).toContain("Schválené");
    expect(workspace).toContain("Zamietnuté");
    expect(workspace).toContain("Odobraté");
  });

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

  it("accepts exact history only for the requested state", () => {
    expect(
      parseAdminCredentialReviewHistoryPage(
        { items: [approvedItem], nextCursor: null },
        "APPROVED",
      ),
    ).toEqual({ items: [approvedItem], nextCursor: null });
    expect(
      parseAdminCredentialReviewHistoryPage(
        { items: [approvedItem], nextCursor: null },
        "REJECTED",
      ),
    ).toBeNull();
    expect(
      parseAdminCredentialReviewHistoryPage(
        {
          items: [{ ...approvedItem, storageKey: "private/credential.pdf" }],
          nextCursor: null,
        },
        "APPROVED",
      ),
    ).toBeNull();
    expect(
      parseAdminCredentialReviewHistoryPage(
        {
          items: [{ ...approvedItem, reviewReason: "unexpected reason" }],
          nextCursor: null,
        },
        "APPROVED",
      ),
    ).toBeNull();
    expect(
      parseAdminCredentialReviewHistoryPage(
        { items: [rejectedItem], nextCursor: null },
        "REJECTED",
      ),
    ).toEqual({ items: [rejectedItem], nextCursor: null });
    expect(
      parseAdminCredentialReviewHistoryPage(
        {
          items: [
            {
              ...rejectedItem,
              evidence: [
                { ...rejectedItem.evidence[0], signedUrl: "https://evil.test" },
              ],
            },
          ],
          nextCursor: null,
        },
        "REJECTED",
      ),
    ).toBeNull();
  });

  it("loads the exact state-filtered history URL without caching", async () => {
    const cursor = "97000000-0000-4000-8000-000000000099";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [approvedItem],
        nextCursor: null,
      }),
    );

    await expect(
      loadAdminCredentialReviewHistory("APPROVED", cursor, fetcher),
    ).resolves.toEqual({
      page: { items: [approvedItem], nextCursor: null },
      status: "OK",
    });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/admin/credential-claims/review-history?state=APPROVED&limit=20&cursor=${cursor}`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("appends every cursor page only within the selected view", () => {
    const nextClaimId = "97000000-0000-4000-8000-000000000002";
    const firstPage = {
      items: [approvedItem],
      nextCursor: nextClaimId,
    };
    const nextPage = {
      items: [{ ...approvedItem, claimId: nextClaimId }],
      nextCursor: null,
    };
    expect(
      appendAdminCredentialReviewPage(firstPage, nextPage, "APPROVED"),
    ).toEqual({
      items: [approvedItem, { ...approvedItem, claimId: nextClaimId }],
      nextCursor: null,
    });
    expect(
      appendAdminCredentialReviewPage(firstPage, firstPage, "APPROVED"),
    ).toBeNull();
    expect(
      appendAdminCredentialReviewPage(
        firstPage,
        { items: [rejectedItem], nextCursor: null },
        "APPROVED",
      ),
    ).toBeNull();
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

  it("revokes an approved claim with the exact reasoned command", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-admin-token" }))
      .mockResolvedValueOnce(
        Response.json({
          claim: {
            claimId,
            reviewReason: "Platnosť oprávnenia bola následne odobratá.",
            reviewReasonCategory: "EXPIRED_OR_INVALID",
            reviewedAt: "2026-09-28T18:00:00.000Z",
            revision: 4,
            state: "REVOKED",
          },
          status: "APPLIED",
        }),
      );

    await expect(
      decideAdminCredentialClaim({
        action: "revoke",
        claimId,
        commandId,
        expectedRevision: 3,
        fetch: fetcher,
        reason: "Platnosť oprávnenia bola následne odobratá.",
        reasonCategory: "EXPIRED_OR_INVALID",
      }),
    ).resolves.toBe("OK");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/admin/credential-claims/${claimId}/revoke`,
    );
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
      commandId,
      expectedRevision: 3,
      reason: "Platnosť oprávnenia bola následne odobratá.",
      reasonCategory: "EXPIRED_OR_INVALID",
    });
  });

  it("keeps the revoke command id stable only for an unavailable retry", () => {
    const attempts = new Map<string, string>();
    const generate = vi.fn(() => commandId);
    expect(
      credentialDecisionCommandId(attempts, claimId, "revoke", generate),
    ).toBe(commandId);
    settleCredentialDecisionAttempt(attempts, claimId, "revoke", "UNAVAILABLE");
    expect(
      credentialDecisionCommandId(attempts, claimId, "revoke", generate),
    ).toBe(commandId);
    expect(generate).toHaveBeenCalledTimes(1);

    settleCredentialDecisionAttempt(attempts, claimId, "revoke", "OK");
    credentialDecisionCommandId(attempts, claimId, "revoke", generate);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("offers revoke only for approved history and keeps closed history read-only", () => {
    const shared = {
      busy: false,
      message: null,
      onDecision: vi.fn(),
      onReasonCategoryChange: vi.fn(),
      onReasonChange: vi.fn(),
      reason: "Platnosť oprávnenia bola následne odobratá.",
      reasonCategory: "EXPIRED_OR_INVALID" as const,
    };
    const approved = renderToStaticMarkup(
      createElement(AdminCredentialReviewDetail, {
        ...shared,
        item: approvedItem,
      }),
    );
    expect(approved).toContain("Overený doklad.");
    expect(approved).toContain("Odobrať overenie");
    expect(approved).toContain(
      `/v1/admin/credential-claims/${claimId}/evidence/${assetId}`,
    );
    expect(approved).not.toContain("Schváliť doklad");

    const rejected = renderToStaticMarkup(
      createElement(AdminCredentialReviewDetail, {
        ...shared,
        item: rejectedItem,
      }),
    );
    expect(rejected).toContain("Dôvod zamietnutia");
    expect(rejected).toContain(rejectedItem.reviewReason);
    expect(rejected).not.toContain("Odobrať overenie");
    expect(rejected).not.toContain("credential-rejection-reason");
    expect(rejected).not.toContain(
      `/v1/admin/credential-claims/${claimId}/evidence/${assetId}`,
    );
  });

  it("treats only approved credentials as verified", () => {
    expect(isVerifiedCredentialState("APPROVED")).toBe(true);
    expect(isVerifiedCredentialState("PENDING")).toBe(false);
    expect(isVerifiedCredentialState("REJECTED")).toBe(false);
    expect(isVerifiedCredentialState("REVOKED")).toBe(false);
  });
});
