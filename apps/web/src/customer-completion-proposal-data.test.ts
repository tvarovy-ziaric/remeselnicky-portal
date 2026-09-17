import { describe, expect, it, vi } from "vitest";

import {
  loadCustomerCompletionProposals,
  parseCustomerCompletionProposals,
  sendCustomerCompletionProposalCommand,
} from "./customer-completion-proposal-data";

const jobId = "89600000-0000-4000-8000-000000000002";
const proposalId = "89600000-0000-4000-8000-000000000003";
const commandId = "89600000-0000-4000-8000-000000000004";
const proposal = {
  id: proposalId,
  proposalNumber: 1,
  proposedAt: "2026-09-17T10:00:00.000Z",
  note: "Práca podľa mňa skončila.",
  outcome: "PENDING",
  decidedAt: null,
  disagreementReason: null,
};
const page = { proposals: [proposal] };

describe("customer completion proposal client", () => {
  it("keeps exact, ordered private proposal history and rejects impossible outcomes", () => {
    expect(parseCustomerCompletionProposals(page)).toEqual([proposal]);
    expect(
      parseCustomerCompletionProposals({ ...page, paid: true }),
    ).toBeNull();
    expect(
      parseCustomerCompletionProposals({
        proposals: [{ ...proposal, providerUserId: jobId }],
      }),
    ).toBeNull();
    expect(
      parseCustomerCompletionProposals({
        proposals: [{ ...proposal, outcome: "AGREE" }],
      }),
    ).toBeNull();
    expect(
      parseCustomerCompletionProposals({
        proposals: [
          { ...proposal, proposalNumber: 2 },
          { ...proposal, proposalNumber: 1 },
        ],
      }),
    ).toBeNull();
    expect(
      parseCustomerCompletionProposals({
        proposals: [
          {
            ...proposal,
            outcome: "DISAGREE",
            decidedAt: "2026-09-17T11:00:00.000Z",
            disagreementReason: "Práca ešte pokračuje.",
          },
        ],
      }),
    ).not.toBeNull();
  });

  it("loads only the exact private Job proposal path", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(page)),
    );
    expect(
      await loadCustomerCompletionProposals({ fetch: fetcher, jobId }),
    ).toEqual({ status: "OK", proposals: [proposal] });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/jobs/${jobId}/completion/proposals`,
      { cache: "no-store", credentials: "same-origin" },
    );
    expect(
      (
        await loadCustomerCompletionProposals({
          fetch: fetcher,
          jobId: "invalid",
        })
      ).status,
    ).toBe("UNAVAILABLE");
  });

  it("requires CSRF and sends only the explicit provider decision", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      if (input === "/v1/auth/csrf")
        return Promise.resolve(Response.json({ csrfToken: "private-csrf" }));
      expect(input).toBe(
        `/v1/me/jobs/${jobId}/completion/proposals/${proposalId}/disagree`,
      );
      expect(init?.headers).toMatchObject({ "x-csrf-token": "private-csrf" });
      if (typeof init?.body !== "string")
        throw new Error("Exact proposal command body missing");
      expect(JSON.parse(init.body) as unknown).toEqual({
        commandId,
        reason: "Práca ešte pokračuje.",
      });
      return Promise.resolve(
        Response.json(
          {
            status: "APPLIED",
            proposalId,
            recordedAt: "2026-09-17T11:00:00.000Z",
          },
          { status: 201 },
        ),
      );
    });
    expect(
      await sendCustomerCompletionProposalCommand({
        fetch: fetcher,
        jobId,
        commandId,
        command: {
          kind: "DISAGREE",
          proposalId,
          reason: "Práca ešte pokračuje.",
        },
      }),
    ).toEqual({ status: "OK", proposalId });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      (
        await sendCustomerCompletionProposalCommand({
          fetch: fetcher,
          jobId,
          commandId,
          command: { kind: "DISAGREE", proposalId, reason: "Krátke" },
        })
      ).status,
    ).toBe("UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
