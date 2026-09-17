import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  assignJobWorkGroupParticipant,
  createJobWorkGroup,
  deriveWorkGroupOptions,
  getRoleCommandId,
  getWorkGroupCommandId,
  getWorkGroupRemovalCommandId,
  JobRosterGroups,
  loadJobRosterPage,
  loadJobWorkGroupListPage,
  parseJobRosterPage,
  parseJobWorkGroupListPage,
  removeJobWorkGroupAssignment,
  sendJobParticipantRoleCommand,
} from "./job-roster.js";

const jobId = "86200000-0000-4000-8000-000000000004";
const participantId = "86200000-0000-4000-8000-000000000006";
const profileId = "86200000-0000-4000-8000-000000000007";
const workGroupId = "86200000-0000-4000-8000-000000000008";
const assignmentId = "86200000-0000-4000-8000-000000000016";
const invitedAt = "2026-09-15T10:00:00.000Z";
const acceptedAt = "2026-09-16T10:00:00.000Z";
const leftAt = "2026-09-20T10:00:00.000Z";
const commandId = "86200000-0000-4000-8000-000000000011";
const otherCommandId = "86200000-0000-4000-8000-000000000012";

const accepted = {
  id: participantId,
  craftsmanProfileId: profileId,
  displayName: "Majster Strecha",
  state: "ACCEPTED",
  invitedAt,
  acceptedAt,
  leftAt: null,
  roles: [
    { role: "LEAD", assignedAt: acceptedAt, endedAt: null, active: true },
  ],
  workGroups: [
    {
      assignmentId,
      workGroupId,
      name: "Strecha",
      crewName: "Crew Alfa",
      assignedAt: acceptedAt,
      endedAt: null,
      active: true,
    },
  ],
};

describe("private Job roster", () => {
  it("requests the bounded same-origin roster with a cursor and no cache", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          role: "CUSTOMER",
          participants: [accepted],
          nextCursor: null,
        }),
      ),
    );
    const result = await loadJobRosterPage({
      fetch: fetcher,
      jobId,
      cursor: { invitedAt, id: participantId },
    });
    expect(result?.participants).toHaveLength(1);
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain(`/v1/me/jobs/${jobId}/roster?`);
    expect(url).toContain("limit=20");
    expect(url).toContain(`beforeId=${participantId}`);
    expect(options).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("fails closed for customer pending identities, extra contacts and malformed history", () => {
    const page = {
      role: "CUSTOMER",
      participants: [accepted],
      nextCursor: null,
    };
    expect(parseJobRosterPage(page)).not.toBeNull();
    expect(
      parseJobRosterPage({
        ...page,
        participants: [{ ...accepted, email: "secret@example.test" }],
      }),
    ).toBeNull();
    expect(
      parseJobRosterPage({
        ...page,
        participants: [
          {
            ...accepted,
            state: "INVITED",
            acceptedAt: null,
            roles: [],
            workGroups: [],
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseJobRosterPage({
        ...page,
        participants: [{ ...accepted, state: "LEFT", leftAt: null }],
      }),
    ).toBeNull();
    expect(
      parseJobRosterPage({
        ...page,
        participants: [
          { ...accepted, roles: [{ ...accepted.roles[0], active: false }] },
        ],
      }),
    ).toBeNull();
    expect(
      parseJobRosterPage({ ...page, participants: [accepted, accepted] }),
    ).toBeNull();
    expect(
      parseJobRosterPage({ ...page, nextCursor: { invitedAt, id: "invalid" } }),
    ).toBeNull();
  });

  it("distinguishes current, historical and unverified provider invitations", () => {
    const historical = {
      ...accepted,
      id: "86200000-0000-4000-8000-000000000009",
      state: "LEFT",
      leftAt,
      roles: [
        {
          role: "MEMBER",
          assignedAt: acceptedAt,
          endedAt: leftAt,
          active: false,
        },
      ],
      workGroups: [],
    };
    const pending = {
      ...accepted,
      id: "86200000-0000-4000-8000-000000000010",
      displayName: "Pozvaný Majster",
      state: "INVITED",
      acceptedAt: null,
      leftAt: null,
      roles: [],
      workGroups: [],
    };
    const page = parseJobRosterPage({
      role: "PRIMARY_PROVIDER",
      participants: [accepted, historical, pending],
      nextCursor: null,
    });
    expect(page).not.toBeNull();
    if (!page) return;
    const html = renderToStaticMarkup(
      <JobRosterGroups page={page} jobState="IN_PROGRESS" />,
    );
    expect(html).toContain("Aktuálni účastníci");
    expect(html).toContain("História účasti");
    expect(html).toContain("Nepotvrdené pozvania");
    expect(html).toContain("nie je overenou účasťou");
    expect(html).toContain("Vedúci skupiny");
    expect(html).toContain("Crew Alfa");
    expect(html).toContain(`/ucasti/schopnosti/${participantId}`);
    expect(html).not.toContain(`/ucasti/schopnosti/${pending.id}`);
    const cancelled = renderToStaticMarkup(
      <JobRosterGroups page={page} jobState="CANCELLED" />,
    );
    expect(cancelled).not.toContain("Potvrdený účastník");
    expect(cancelled).toContain("Potvrdená účasť na zrušenej zákazke");
  });

  it("shows independent editable roles only for accepted participants of an active provider Job", () => {
    const pending = {
      ...accepted,
      id: "86200000-0000-4000-8000-000000000010",
      state: "INVITED",
      acceptedAt: null,
      roles: [],
      workGroups: [],
    };
    const left = {
      ...accepted,
      id: "86200000-0000-4000-8000-000000000013",
      state: "LEFT",
      leftAt,
      roles: [{ ...accepted.roles[0], endedAt: leftAt, active: false }],
      workGroups: [],
    };
    const declined = {
      ...pending,
      id: "86200000-0000-4000-8000-000000000014",
      state: "DECLINED",
    };
    const removed = {
      ...left,
      id: "86200000-0000-4000-8000-000000000015",
      state: "REMOVED",
    };
    const provider = parseJobRosterPage({
      role: "PRIMARY_PROVIDER",
      participants: [accepted, pending, declined, left, removed],
      nextCursor: null,
    });
    expect(provider).not.toBeNull();
    if (!provider) return;
    const callback = vi.fn();
    const html = renderToStaticMarkup(
      <JobRosterGroups
        page={provider}
        jobState="IN_PROGRESS"
        onRoleAction={callback}
      />,
    );
    expect(html).toContain("Odobrať rolu Vedúci skupiny");
    expect(html).toContain("Prideliť rolu Koordinátor");
    expect(html).toContain("Prideliť rolu Stavbyvedúci");
    expect(html).not.toMatch(/Prideliť rolu Člen|Odobrať rolu Člen/u);
    expect((html.match(/job-roster-role-controls/gu) ?? []).length).toBe(1);
    const customer = parseJobRosterPage({
      role: "CUSTOMER",
      participants: [accepted, left],
      nextCursor: null,
    });
    expect(customer).not.toBeNull();
    if (!customer) return;
    expect(
      renderToStaticMarkup(
        <JobRosterGroups page={customer} jobState="IN_PROGRESS" />,
      ),
    ).not.toContain(`/ucasti/schopnosti/${participantId}`);
    expect(
      renderToStaticMarkup(
        <JobRosterGroups
          page={customer}
          jobState="IN_PROGRESS"
          onRoleAction={callback}
        />,
      ),
    ).not.toContain("job-roster-role-controls");
    expect(
      renderToStaticMarkup(
        <JobRosterGroups
          page={provider}
          jobState="CANCELLED"
          onRoleAction={callback}
        />,
      ),
    ).not.toContain("job-roster-role-controls");
  });

  it("reuses an uncertain role command per participant, role and action", () => {
    const attempts = new Map<string, string>();
    expect(
      getRoleCommandId(
        attempts,
        participantId,
        "LEAD",
        "ASSIGN",
        () => commandId,
      ),
    ).toBe(commandId);
    expect(
      getRoleCommandId(
        attempts,
        participantId,
        "COORDINATOR",
        "ASSIGN",
        () => otherCommandId,
      ),
    ).toBe(otherCommandId);
    expect(
      getRoleCommandId(attempts, participantId, "LEAD", "ASSIGN", () => {
        throw new Error("must reuse");
      }),
    ).toBe(commandId);
    expect(
      getRoleCommandId(
        attempts,
        participantId,
        "LEAD",
        "REVOKE",
        () => otherCommandId,
      ),
    ).toBe(otherCommandId);
  });

  it("uses CSRF and accepts only a matching, verified role outcome", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            status: "APPLIED",
            role: "LEAD",
            active: true,
            recordedAt: acceptedAt,
          },
          { status: 201 },
        ),
      );
    await expect(
      sendJobParticipantRoleCommand({
        fetch: fetcher,
        participantId,
        commandId,
        role: "LEAD",
        action: "ASSIGN",
      }),
    ).resolves.toEqual({ status: "OK", active: true });
    expect(fetcher.mock.calls).toEqual([
      ["/v1/auth/csrf", { cache: "no-store", credentials: "same-origin" }],
      [
        `/v1/me/job-participations/${participantId}/roles`,
        {
          body: JSON.stringify({ commandId, role: "LEAD", action: "ASSIGN" }),
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": "csrf-test",
          },
          method: "POST",
        },
      ],
    ]);
  });

  it("fails closed on MEMBER, malformed CSRF/outcomes and 401/403/404/409", async () => {
    const noNetwork = vi.fn<typeof fetch>();
    await expect(
      sendJobParticipantRoleCommand({
        fetch: noNetwork,
        participantId,
        commandId,
        role: "MEMBER" as unknown as "LEAD",
        action: "ASSIGN",
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(noNetwork).not.toHaveBeenCalled();
    for (const body of [
      {
        status: "APPLIED",
        role: "MEMBER",
        active: true,
        recordedAt: acceptedAt,
      },
      {
        status: "APPLIED",
        role: "LEAD",
        active: false,
        recordedAt: acceptedAt,
      },
      { status: "APPLIED", role: "LEAD", active: true, recordedAt: "invalid" },
      {
        status: "APPLIED",
        role: "LEAD",
        active: true,
        recordedAt: acceptedAt,
        customerEmail: "private",
      },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(Response.json(body));
      await expect(
        sendJobParticipantRoleCommand({
          fetch: fetcher,
          participantId,
          commandId,
          role: "LEAD",
          action: "ASSIGN",
        }),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
    for (const status of [401, 403, 404, 409]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(new Response(null, { status }));
      await expect(
        sendJobParticipantRoleCommand({
          fetch: fetcher,
          participantId,
          commandId,
          role: "LEAD",
          action: "ASSIGN",
        }),
      ).resolves.toEqual({
        status: status === 401 ? "AUTH_REQUIRED" : "UNAVAILABLE",
      });
    }
    const malformedCsrf = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ csrfToken: "csrf-test", secret: "leak" }),
      );
    await expect(
      sendJobParticipantRoleCommand({
        fetch: malformedCsrf,
        participantId,
        commandId,
        role: "LEAD",
        action: "ASSIGN",
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(malformedCsrf).toHaveBeenCalledTimes(1);
  });

  it("shows job-specific work groups and creation/assignment only for an active provider Job", () => {
    const provider = parseJobRosterPage({
      role: "PRIMARY_PROVIDER",
      participants: [accepted],
      nextCursor: null,
    });
    expect(provider).not.toBeNull();
    if (!provider) return;
    const created = [
      {
        id: "86200000-0000-4000-8000-000000000017",
        name: "Montáž",
        crewName: null,
        createdAt: acceptedAt,
      },
      {
        id: workGroupId,
        name: "Strecha",
        crewName: "Crew Alfa",
        createdAt: invitedAt,
      },
    ];
    const options = deriveWorkGroupOptions(provider, created);
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: workGroupId,
          activeMemberNames: ["Majster Strecha"],
        }),
        expect.objectContaining({ id: created[0]?.id, activeMemberNames: [] }),
      ]),
    );
    const controls = {
      onGroupCreate: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      onGroupAssign: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      onGroupRemove: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    };
    const html = renderToStaticMarkup(
      <JobRosterGroups
        page={provider}
        jobState="IN_PROGRESS"
        workGroups={created}
        {...controls}
      />,
    );
    expect(html).toContain("Pracovné skupiny zákazky");
    expect(html).toContain("Vytvoriť skupinu");
    expect(html).toContain("Priradiť do skupiny");
    expect(html).toContain(
      "Aktuálne priradení z načítaných účastníkov: Majster Strecha",
    );
    expect(html).toContain("Členstvo v opakovane používanej");
    expect(html).toContain("Odobrať zo skupiny");
    expect(html).not.toContain("Odísť zo skupiny");
    const customer = parseJobRosterPage({
      role: "CUSTOMER",
      participants: [accepted],
      nextCursor: null,
    });
    expect(customer).not.toBeNull();
    if (!customer) return;
    expect(
      renderToStaticMarkup(
        <JobRosterGroups
          page={customer}
          jobState="IN_PROGRESS"
          workGroups={created}
          {...controls}
        />,
      ),
    ).not.toContain("job-work-group-controls");
    expect(
      renderToStaticMarkup(
        <JobRosterGroups
          page={customer}
          jobState="IN_PROGRESS"
          workGroups={created}
          {...controls}
        />,
      ),
    ).not.toContain("Odobrať zo skupiny");
    expect(
      renderToStaticMarkup(
        <JobRosterGroups
          page={provider}
          jobState="CANCELLED"
          workGroups={created}
          {...controls}
        />,
      ),
    ).not.toContain("job-work-group-controls");
    expect(
      renderToStaticMarkup(
        <JobRosterGroups
          page={provider}
          jobState="CANCELLED"
          workGroups={created}
          {...controls}
        />,
      ),
    ).not.toContain("Odobrať zo skupiny");
  });

  it("requires immutable assignment IDs in every roster interval", () => {
    const page = {
      role: "PRIMARY_PROVIDER",
      participants: [accepted],
      nextCursor: null,
    };
    expect(parseJobRosterPage(page)).not.toBeNull();
    expect(
      parseJobRosterPage({
        ...page,
        participants: [
          {
            ...accepted,
            workGroups: [{ ...accepted.workGroups[0], assignmentId: "bad" }],
          },
        ],
      }),
    ).toBeNull();
    const withoutId: Record<string, unknown> = { ...accepted.workGroups[0] };
    delete withoutId.assignmentId;
    expect(
      parseJobRosterPage({
        ...page,
        participants: [{ ...accepted, workGroups: [withoutId] }],
      }),
    ).toBeNull();
    expect(
      parseJobRosterPage({
        ...page,
        participants: [
          accepted,
          { ...accepted, id: "86200000-0000-4000-8000-000000000018" },
        ],
      }),
    ).toBeNull();
  });

  it("loads private empty group identities with bounded cursor and no customer/contact leakage", async () => {
    const group = {
      id: workGroupId,
      name: "Montáž",
      crewName: null,
      createdAt: acceptedAt,
    };
    const payload = {
      groups: [group],
      nextCursor: { createdAt: acceptedAt, id: workGroupId },
    };
    expect(parseJobWorkGroupListPage(payload)).toEqual(payload);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(payload));
    await expect(
      loadJobWorkGroupListPage({
        fetch: fetcher,
        jobId,
        cursor: { createdAt: acceptedAt, id: workGroupId },
      }),
    ).resolves.toEqual(payload);
    expect(fetcher.mock.calls[0]).toEqual([
      `/v1/me/jobs/${jobId}/work-groups?limit=50&beforeAt=2026-09-16T10%3A00%3A00.000Z&beforeId=${workGroupId}`,
      { cache: "no-store", credentials: "same-origin" },
    ]);
    for (const bad of [
      { groups: [{ ...group, exactAddress: "private" }], nextCursor: null },
      { groups: [{ ...group, id: "bad" }], nextCursor: null },
      {
        groups: [group],
        nextCursor: { createdAt: acceptedAt, id: participantId },
      },
      { groups: [group, group], nextCursor: null },
      {
        groups: Array.from({ length: 51 }, (_, n) => ({
          ...group,
          id: `86200000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        })),
        nextCursor: null,
      },
    ])
      expect(parseJobWorkGroupListPage(bad)).toBeNull();
  });

  it("keeps uncertain create and assignment command IDs separate", () => {
    const attempts = new Map<string, string>();
    expect(
      getWorkGroupCommandId(attempts, "create:Montáž", () => commandId),
    ).toBe(commandId);
    expect(
      getWorkGroupCommandId(
        attempts,
        `assign:${workGroupId}:${participantId}`,
        () => otherCommandId,
      ),
    ).toBe(otherCommandId);
    expect(
      getWorkGroupCommandId(attempts, "create:Montáž", () => {
        throw new Error("must reuse");
      }),
    ).toBe(commandId);
    expect(
      getWorkGroupCommandId(
        attempts,
        `assign:${workGroupId}:${participantId}`,
        () => {
          throw new Error("must reuse");
        },
      ),
    ).toBe(otherCommandId);
  });

  it("creates a group through CSRF with strict response validation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          { status: "APPLIED", workGroupId, createdAt: acceptedAt },
          { status: 201 },
        ),
      );
    await expect(
      createJobWorkGroup({ fetch: fetcher, jobId, commandId, name: "Montáž" }),
    ).resolves.toEqual({ status: "CREATED", workGroupId });
    expect(fetcher.mock.calls).toEqual([
      ["/v1/auth/csrf", { cache: "no-store", credentials: "same-origin" }],
      [
        `/v1/me/jobs/${jobId}/work-groups`,
        {
          body: JSON.stringify({ commandId, name: "Montáž" }),
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": "csrf-test",
          },
          method: "POST",
        },
      ],
    ]);
  });

  it("assigns only a concrete participant to a concrete group via CSRF", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "DEDUPLICATED",
          assignmentId,
          assignedAt: acceptedAt,
        }),
      );
    await expect(
      assignJobWorkGroupParticipant({
        fetch: fetcher,
        workGroupId,
        participantId,
        commandId,
      }),
    ).resolves.toEqual({ status: "ASSIGNED", assignmentId });
    expect(fetcher.mock.calls[1]).toEqual([
      `/v1/me/job-work-groups/${workGroupId}/assignments`,
      {
        body: JSON.stringify({ commandId, participantId }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": "csrf-test",
        },
        method: "POST",
      },
    ]);
  });

  it("rejects invalid group commands, leaked response fields and denied mutations", async () => {
    const noNetwork = vi.fn<typeof fetch>();
    await expect(
      createJobWorkGroup({ fetch: noNetwork, jobId, commandId, name: "x" }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    await expect(
      assignJobWorkGroupParticipant({
        fetch: noNetwork,
        workGroupId: "bad",
        participantId,
        commandId,
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(noNetwork).not.toHaveBeenCalled();
    for (const body of [
      {
        status: "APPLIED",
        workGroupId,
        createdAt: acceptedAt,
        customerEmail: "private",
      },
      { status: "APPLIED", workGroupId: "bad", createdAt: acceptedAt },
      { status: "APPLIED", workGroupId, createdAt: "invalid" },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(Response.json(body));
      await expect(
        createJobWorkGroup({
          fetch: fetcher,
          jobId,
          commandId,
          name: "Montáž",
        }),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
    for (const body of [
      {
        status: "APPLIED",
        assignmentId,
        assignedAt: acceptedAt,
        exactAddress: "private",
      },
      { status: "APPLIED", assignmentId: "bad", assignedAt: acceptedAt },
      { status: "APPLIED", assignmentId, assignedAt: "invalid" },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(Response.json(body));
      await expect(
        assignJobWorkGroupParticipant({
          fetch: fetcher,
          workGroupId,
          participantId,
          commandId,
        }),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
    for (const status of [401, 403, 404, 409]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(new Response(null, { status }));
      await expect(
        createJobWorkGroup({
          fetch: fetcher,
          jobId,
          commandId,
          name: "Montáž",
        }),
      ).resolves.toEqual({
        status: status === 401 ? "AUTH_REQUIRED" : "UNAVAILABLE",
      });
    }
    const csrfDenied = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      assignJobWorkGroupParticipant({
        fetch: csrfDenied,
        workGroupId,
        participantId,
        commandId,
      }),
    ).resolves.toEqual({ status: "AUTH_REQUIRED" });
    expect(csrfDenied).toHaveBeenCalledTimes(1);
  });

  it("removes one active assignment with a bounded reason and preserves retry intent", async () => {
    const attempts = new Map<string, { reason: string; commandId: string }>();
    const reason = "Preradenie do inej skupiny.";
    expect(
      getWorkGroupRemovalCommandId(
        attempts,
        assignmentId,
        reason,
        () => commandId,
      ),
    ).toBe(commandId);
    expect(
      getWorkGroupRemovalCommandId(attempts, assignmentId, reason, () => {
        throw new Error("must reuse");
      }),
    ).toBe(commandId);
    expect(
      getWorkGroupRemovalCommandId(
        attempts,
        assignmentId,
        "Zmenený dôvod",
        () => otherCommandId,
      ),
    ).toBeNull();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json({ status: "DEDUPLICATED", endedAt: leftAt }),
      );
    await expect(
      removeJobWorkGroupAssignment({
        fetch: fetcher,
        assignmentId,
        commandId,
        reason,
      }),
    ).resolves.toEqual({ status: "REMOVED", endedAt: leftAt });
    expect(fetcher.mock.calls[1]).toEqual([
      `/v1/me/job-work-group-assignments/${assignmentId}/departure`,
      {
        body: JSON.stringify({ commandId, action: "REMOVE", reason }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": "csrf-test",
        },
        method: "POST",
      },
    ]);
  });

  it("fails closed for invalid removal target/reason, leaked outcomes and denial", async () => {
    const noNetwork = vi.fn<typeof fetch>();
    for (const reason of ["short", "A".repeat(501), "Zlý\ndôvod"])
      await expect(
        removeJobWorkGroupAssignment({
          fetch: noNetwork,
          assignmentId,
          commandId,
          reason,
        }),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    await expect(
      removeJobWorkGroupAssignment({
        fetch: noNetwork,
        assignmentId: "bad",
        commandId,
        reason: "Bezpečný dôvod",
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(noNetwork).not.toHaveBeenCalled();
    for (const body of [
      { status: "APPLIED", endedAt: "bad" },
      { status: "APPLIED", endedAt: leftAt, customerEmail: "private" },
      { status: "UNKNOWN", endedAt: leftAt },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(Response.json(body));
      await expect(
        removeJobWorkGroupAssignment({
          fetch: fetcher,
          assignmentId,
          commandId,
          reason: "Bezpečný dôvod",
        }),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
    for (const status of [401, 403, 404, 409]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(new Response(null, { status }));
      await expect(
        removeJobWorkGroupAssignment({
          fetch: fetcher,
          assignmentId,
          commandId,
          reason: "Bezpečný dôvod",
        }),
      ).resolves.toEqual({
        status: status === 401 ? "AUTH_REQUIRED" : "UNAVAILABLE",
      });
    }
  });
});
