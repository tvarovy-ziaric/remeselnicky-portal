import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CapabilityClaimList,
  confirmCapability,
  getCapabilityConfirmationCommandId,
  getCapabilityProposalAttempt,
  loadCapabilityPage,
  parseCapabilityPage,
  ParticipantCapabilities,
  proposeCapability,
} from "./participant-capabilities";

const participantId = "9d500000-0000-4000-8000-000000000001";
const claimId = "9d500000-0000-4000-8000-000000000002";
const releaseId = "9d500000-0000-4000-8000-000000000003";
const proposer = "9d500000-0000-4000-8000-000000000004";
const confirmer = "9d500000-0000-4000-8000-000000000005";
const commandId = "9d500000-0000-4000-8000-000000000006";
const proposedAt = "2026-09-17T08:00:00.000Z";
const confirmedAt = "2026-09-17T09:00:00.000Z";
const claim = {
  claimId,
  participantId,
  kind: "PROFESSION",
  professionTaxonomyReleaseId: releaseId,
  professionCode: "PROF:ELECTRICIAN",
  skillCatalogReleaseId: null,
  skillCode: null,
  customSkillText: null,
  proposedByUserId: proposer,
  proposedAt,
  confirmedByUserId: null,
  confirmedAt: null,
  status: "PROPOSED",
  canConfirm: false,
};
const page = {
  items: [claim],
  canAct: true,
  canPropose: true,
  nextCursor: null,
};

describe("Job participant capability evidence", () => {
  it("renders no private claims before authorized loading", () => {
    const html = renderToStaticMarkup(
      <ParticipantCapabilities participantId={participantId} />,
    );
    expect(html).toContain("Načítavam profesie");
    expect(html).not.toContain("PROF:ELECTRICIAN");
  });

  it("accepts only exact private provenance and aligned cursor", () => {
    expect(parseCapabilityPage(page, participantId)).toEqual(page);
    expect(
      parseCapabilityPage(
        { ...page, nextCursor: { proposedAt, id: claimId } },
        participantId,
      ),
    ).not.toBeNull();
    expect(
      parseCapabilityPage(
        { ...page, nextCursor: { proposedAt, id: proposer } },
        participantId,
      ),
    ).toBeNull();
    expect(
      parseCapabilityPage({ ...page, items: [claim, claim] }, participantId),
    ).toBeNull();
    expect(
      parseCapabilityPage({ ...page, canAct: "yes" }, participantId),
    ).toBeNull();
    expect(
      parseCapabilityPage({ ...page, canPropose: "yes" }, participantId),
    ).toBeNull();
    expect(
      parseCapabilityPage(
        { ...page, canPropose: true, canAct: false },
        participantId,
      ),
    ).toBeNull();
    expect(
      parseCapabilityPage(
        { ...page, items: [{ ...claim, canConfirm: "yes" }] },
        participantId,
      ),
    ).toBeNull();
    expect(
      parseCapabilityPage(
        {
          ...page,
          items: [{ ...claim, canConfirm: true }],
          canAct: false,
          canPropose: false,
        },
        participantId,
      ),
    ).toBeNull();
    expect(
      parseCapabilityPage(
        { ...page, customerContact: "private" },
        participantId,
      ),
    ).toBeNull();
  });

  it("rejects leaked fields, false confirmation and malformed capability identity", () => {
    for (const broken of [
      { ...claim, exactAddress: "private" },
      { ...claim, participantId: proposer },
      { ...claim, professionCode: "bad" },
      { ...claim, skillCode: "SKILL:TEST" },
      { ...claim, confirmedByUserId: confirmer },
      { ...claim, canConfirm: "true" },
      {
        ...claim,
        status: "CONFIRMED",
        confirmedByUserId: proposer,
        confirmedAt,
      },
      {
        ...claim,
        status: "CONFIRMED",
        confirmedByUserId: confirmer,
        confirmedAt,
        canConfirm: true,
      },
      {
        ...claim,
        status: "CONFIRMED",
        confirmedByUserId: confirmer,
        confirmedAt: proposedAt.replace("08:00", "07:00"),
      },
      {
        ...claim,
        kind: "CUSTOM_SKILL",
        professionCode: null,
        professionTaxonomyReleaseId: null,
        customSkillText: "x",
      },
      {
        ...claim,
        kind: "CUSTOM_SKILL",
        professionCode: null,
        professionTaxonomyReleaseId: null,
        customSkillText: "contact@example.test",
      },
    ])
      expect(
        parseCapabilityPage({ ...page, items: [broken] }, participantId),
      ).toBeNull();
    expect(
      parseCapabilityPage(
        {
          ...page,
          items: [
            {
              ...claim,
              status: "CONFIRMED",
              confirmedByUserId: confirmer,
              confirmedAt,
            },
          ],
        },
        participantId,
      ),
    ).not.toBeNull();
  });

  it("uses private bounded no-store pagination and denies unauthorized reads", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      loadCapabilityPage({
        fetch: fetcher,
        participantId,
        cursor: { proposedAt, id: claimId },
      }),
    ).resolves.toEqual({ status: "OK", page });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/v1/me/job-participations/${participantId}/capabilities?limit=20&beforeAt=2026-09-17T08%3A00%3A00.000Z&beforeId=${claimId}`,
    );
    expect(fetcher.mock.calls[0]?.[1]).toEqual({
      cache: "no-store",
      credentials: "same-origin",
    });
    await expect(
      loadCapabilityPage({ fetch: fetcher, participantId }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("uses only per-item server permission, including for an authorized lead", () => {
    const own = renderToStaticMarkup(
      <CapabilityClaimList
        page={page as never}
        busy={false}
        onConfirm={() => undefined}
      />,
    );
    expect(own).toContain("zatiaľ nejde o overený dôkaz");
    expect(own).not.toContain("Potvrdiť vykonanú činnosť");
    const lead = {
      ...page,
      canPropose: false,
      items: [{ ...claim, canConfirm: true }],
    };
    expect(parseCapabilityPage(lead, participantId)).not.toBeNull();
    const authorized = renderToStaticMarkup(
      <CapabilityClaimList
        page={lead as never}
        busy={false}
        onConfirm={() => undefined}
      />,
    );
    expect(authorized).toContain("Potvrdiť vykonanú činnosť");
    const ended = renderToStaticMarkup(
      <CapabilityClaimList
        page={{ ...page, canAct: false, canPropose: false } as never}
        busy={false}
        onConfirm={() => undefined}
      />,
    );
    expect(ended).not.toContain("Potvrdiť vykonanú činnosť");
    expect(
      parseCapabilityPage({ ...lead, canAct: false }, participantId),
    ).toBeNull();
  });

  it("posts only a selected canonical code or safe custom text with CSRF", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "APPLIED",
          claimId,
          claimStatus: "PROPOSED",
          proposedAt,
        }),
      );
    await expect(
      proposeCapability({
        fetch: fetcher,
        participantId,
        commandId,
        proposal: { kind: "PROFESSION", professionCode: "PROF:ELECTRICIAN" },
      }),
    ).resolves.toBe("OK");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/me/job-participations/${participantId}/capabilities`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toEqual({
      body: JSON.stringify({
        commandId,
        kind: "PROFESSION",
        professionCode: "PROF:ELECTRICIAN",
      }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": "csrf",
      },
      method: "POST",
    });
    const none = vi.fn<typeof fetch>();
    await expect(
      proposeCapability({
        fetch: none,
        participantId,
        commandId,
        proposal: { kind: "CUSTOM_SKILL", customSkillText: " Unsafe" },
      }),
    ).resolves.toBe("UNAVAILABLE");
    await expect(
      proposeCapability({
        fetch: none,
        participantId,
        commandId,
        proposal: {
          kind: "CUSTOM_SKILL",
          customSkillText: "https://example.test",
        },
      }),
    ).resolves.toBe("UNAVAILABLE");
    expect(none).not.toHaveBeenCalled();
  });

  it("keeps an uncertain proposal or confirmation tied to its original command ID", () => {
    const profession = {
      kind: "PROFESSION" as const,
      professionCode: "PROF:ELECTRICIAN",
    };
    const first = getCapabilityProposalAttempt(
      null,
      profession,
      () => commandId,
    );
    expect(
      getCapabilityProposalAttempt(
        first,
        { kind: "CUSTOM_SKILL", customSkillText: "Montáž" },
        () => {
          throw new Error("must not allocate");
        },
      ),
    ).toBe(first);
    const attempts = new Map<string, string>();
    expect(
      getCapabilityConfirmationCommandId(attempts, claimId, () => commandId),
    ).toBe(commandId);
    expect(
      getCapabilityConfirmationCommandId(attempts, claimId, () => {
        throw new Error("must not allocate");
      }),
    ).toBe(commandId);
    expect(
      getCapabilityConfirmationCommandId(attempts, proposer, () => confirmer),
    ).toBe(confirmer);
    expect(attempts.get(claimId)).toBe(commandId);
  });

  it("posts an exact opposite-party confirmation and accepts only its matching result", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "DEDUPLICATED",
          claimId,
          claimStatus: "CONFIRMED",
          confirmedAt,
        }),
      );
    await expect(
      confirmCapability({ fetch: fetcher, participantId, claimId, commandId }),
    ).resolves.toBe("OK");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/me/job-participations/${participantId}/capabilities/${claimId}/confirm`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toEqual({
      body: JSON.stringify({ commandId }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": "csrf",
      },
      method: "POST",
    });
  });

  it("does not infer proposal or confirmation from malformed success bodies", async () => {
    for (const body of [
      { status: "APPLIED", claimId, claimStatus: "CONFIRMED", proposedAt },
      {
        status: "APPLIED",
        claimId,
        claimStatus: "PROPOSED",
        proposedAt,
        exactAddress: "private",
      },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf" }))
        .mockResolvedValueOnce(Response.json(body));
      await expect(
        proposeCapability({
          fetch: fetcher,
          participantId,
          commandId,
          proposal: { kind: "CUSTOM_SKILL", customSkillText: "Montáž" },
        }),
      ).resolves.toBe("UNAVAILABLE");
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "APPLIED",
          claimId: proposer,
          claimStatus: "CONFIRMED",
          confirmedAt,
        }),
      );
    await expect(
      confirmCapability({ fetch: fetcher, participantId, claimId, commandId }),
    ).resolves.toBe("UNAVAILABLE");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ commandId }),
      method: "POST",
    });
  });
});
