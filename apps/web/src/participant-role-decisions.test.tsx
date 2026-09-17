import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  getRoleDecisionCommandId,
  loadPendingRoleAssignments,
  parsePendingRoleAssignments,
  ParticipantRoleDecisions,
  sendRoleDecision,
} from "./participant-role-decisions";

const participantId = "e7100000-0000-4000-8000-000000000001";
const assignmentEventId = "e7100000-0000-4000-8000-000000000002";
const commandId = "e7100000-0000-4000-8000-000000000003";
const assignedAt = "2026-09-17T08:00:00.000Z";
const page = {
  items: [{ assignmentEventId, participantId, role: "LEAD", assignedAt }],
};

describe("participant-confirmed Job roles", () => {
  it("parses only the bounded private pending-assignment projection", () => {
    expect(parsePendingRoleAssignments(page, participantId)).toEqual(page);
    expect(
      parsePendingRoleAssignments(
        {
          items: [{ ...page.items[0], customerEmail: "private@example.test" }],
        },
        participantId,
      ),
    ).toBeNull();
    expect(
      parsePendingRoleAssignments(
        { items: [{ ...page.items[0], participantId: commandId }] },
        participantId,
      ),
    ).toBeNull();
    expect(
      parsePendingRoleAssignments(
        { items: [page.items[0], page.items[0]] },
        participantId,
      ),
    ).toBeNull();
  });

  it("loads only the same-origin private role list and treats 404 uniformly", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(page));
    await expect(
      loadPendingRoleAssignments({ fetch: fetcher, participantId }),
    ).resolves.toEqual({ status: "OK", page });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/job-participations/${participantId}/role-assignments`,
      { cache: "no-store", credentials: "same-origin" },
    );
    fetcher.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      loadPendingRoleAssignments({ fetch: fetcher, participantId }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
  });

  it("reuses the exact decision command after an uncertain outcome", () => {
    const attempts: Parameters<typeof getRoleDecisionCommandId>[0] = new Map();
    expect(
      getRoleDecisionCommandId(
        attempts,
        assignmentEventId,
        "CONFIRM",
        null,
        () => commandId,
      ),
    ).toBe(commandId);
    expect(
      getRoleDecisionCommandId(
        attempts,
        assignmentEventId,
        "CONFIRM",
        null,
        () => "invalid",
      ),
    ).toBe(commandId);
    expect(
      getRoleDecisionCommandId(
        attempts,
        assignmentEventId,
        "REQUEST_CORRECTION",
        "Nesedí mi rola.",
        () => "invalid",
      ),
    ).toBeNull();
  });

  it("sends an exact CSRF-protected confirmation without client actor identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "token" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "APPLIED",
          decisionId: commandId,
          decision: "CONFIRM",
          decidedAt: assignedAt,
        }),
      );
    await expect(
      sendRoleDecision({
        fetch: fetcher,
        participantId,
        assignmentEventId,
        commandId,
        decision: "CONFIRM",
        reason: null,
      }),
    ).resolves.toBe("OK");
    const post = fetcher.mock.calls[1];
    expect(post?.[0]).toBe(
      `/v1/me/job-participations/${participantId}/role-assignments/${assignmentEventId}/decision`,
    );
    expect(post?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "x-csrf-token": "token" },
    });
    const body = post?.[1]?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({
      commandId,
      decision: "CONFIRM",
    });
    expect(JSON.stringify(post?.[1])).not.toContain("actorUserId");
  });

  it("rejects an invalid correction before any network request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      sendRoleDecision({
        fetch: fetcher,
        participantId,
        assignmentEventId,
        commandId,
        decision: "REQUEST_CORRECTION",
        reason: "short",
      }),
    ).resolves.toBe("UNAVAILABLE");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renders no role identity before the authorized read", () => {
    const html = renderToStaticMarkup(
      <ParticipantRoleDecisions participantId={participantId} />,
    );
    expect(html).toContain("Načítavam roly");
    expect(html).not.toContain("Vedúci");
  });
});
