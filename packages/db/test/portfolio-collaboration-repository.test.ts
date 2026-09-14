import type {
  CraftsmanProfileId,
  PortfolioCollaborationId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createPortfolioCollaborationRepository,
  PortfolioCollaborationIdempotencyError,
} from "../src/portfolio-collaboration-repository.js";

const author = "77000000-0000-4000-8000-000000000001" as UserId;
const collaborator = "77000000-0000-4000-8000-000000000002" as UserId;
const authorProfile =
  "77000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const collaboratorProfile =
  "77000000-0000-4000-8000-000000000004" as CraftsmanProfileId;
const projectId = "77000000-0000-4000-8000-000000000005" as PortfolioProjectId;
const collaborationId =
  "77000000-0000-4000-8000-000000000006" as PortfolioCollaborationId;

describe("portfolio collaboration repository", () => {
  it("uniformly denies an unavailable author before command lookup", async () => {
    const sql = scriptedSql([[]]);
    await expect(
      createPortfolioCollaborationRepository(sql).invite(invite()),
    ).resolves.toEqual({ status: "COLLABORATION_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
  });

  it("creates an explicit pending invitation with immutable attribution content", async () => {
    const sql = scriptedSql([
      profileLocks(),
      [{ id: projectId }],
      [],
      [],
      [],
      [],
      [],
      [row()],
    ]);
    await expect(
      createPortfolioCollaborationRepository(sql).invite(invite()),
    ).resolves.toMatchObject({
      collaboration: {
        collaboratorProfileId: collaboratorProfile,
        contribution: invite().contribution,
        role: invite().role,
        state: "PENDING",
      },
      status: "APPLIED",
    });
    expect(sql.queries.join("\n")).toMatch(
      /INSERT INTO portfolio_collaborations[\s\S]*INSERT INTO portfolio_collaboration_commands[\s\S]*INSERT INTO portfolio_collaboration_revisions/u,
    );
  });

  it("allows only the active invited profile owner to accept", async () => {
    const denied = scriptedSql([[]]);
    await expect(
      createPortfolioCollaborationRepository(denied).accept({
        actorUserId: author,
        collaborationId,
        collaboratorProfileId: collaboratorProfile,
        commandId: "77000000-0000-4000-8000-000000000007",
        expectedRevision: 1,
        portfolioProjectId: projectId,
      }),
    ).resolves.toEqual({ status: "COLLABORATION_UNAVAILABLE" });

    const acceptedAt = new Date("2026-09-14T12:00:00.000Z");
    const accepted = row({
      acceptedAt,
      revision: 2,
      state: "ACCEPTED",
    });
    const sql = scriptedSql([
      [identity()],
      [{ id: collaboratorProfile }],
      [{ id: projectId }],
      [row()],
      [],
      [],
      [],
      [],
      [accepted],
    ]);
    await expect(
      createPortfolioCollaborationRepository(sql).accept({
        actorUserId: collaborator,
        collaborationId,
        collaboratorProfileId: collaboratorProfile,
        commandId: "77000000-0000-4000-8000-000000000008",
        expectedRevision: 1,
        portfolioProjectId: projectId,
      }),
    ).resolves.toMatchObject({
      collaboration: { acceptedAt, state: "ACCEPTED" },
      status: "APPLIED",
    });
  });

  it("uses CAS and leaves an accepted attribution unchanged on stale edits", async () => {
    const sql = scriptedSql([
      [identity()],
      [{ id: authorProfile }],
      [{ id: projectId }],
      [row({ revision: 2, state: "ACCEPTED" })],
      [],
    ]);
    await expect(
      createPortfolioCollaborationRepository(sql).editPending({
        actorUserId: author,
        collaborationId,
        commandId: "77000000-0000-4000-8000-000000000009",
        contribution: "Iný bezpečný príspevok.",
        expectedRevision: 1,
        portfolioProjectId: projectId,
        role: "Pomocník",
      }),
    ).resolves.toEqual({ status: "STALE_REVISION" });
    expect(sql.queries.join("\n")).not.toMatch(
      /UPDATE portfolio_collaborations/u,
    );
  });

  it("rejects command id reuse across authority, kind or payload", async () => {
    const sql = scriptedSql([
      [identity()],
      [{ id: authorProfile }],
      [{ id: projectId }],
      [row()],
      [
        {
          actorKind: "AUTHOR",
          actorUserId: author,
          collaborationId,
          commandKind: "HIDE",
          payloadFingerprint: "f".repeat(64),
          portfolioProjectId: projectId,
          resultingRevision: 2,
        },
      ],
    ]);
    await expect(
      createPortfolioCollaborationRepository(sql).hide({
        actorUserId: author,
        collaborationId,
        commandId: "77000000-0000-4000-8000-000000000010",
        expectedRevision: 1,
        portfolioProjectId: projectId,
      }),
    ).rejects.toThrow(PortfolioCollaborationIdempotencyError);
  });
});

interface ScriptedSql extends Sql {
  readonly queries: string[];
}

function scriptedSql(responses: readonly unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => work(tagged),
    queries,
  });
  return tagged;
}

function invite() {
  return {
    actorUserId: author,
    authorProfileId: authorProfile,
    collaboratorProfileId: collaboratorProfile,
    collaborationId,
    commandId: "77000000-0000-4000-8000-000000000011",
    contribution: "Kompletná elektroinštalácia dielne.",
    portfolioProjectId: projectId,
    role: "Elektrikár",
  };
}

function row(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-09-14T11:00:00.000Z");
  return {
    acceptedAt: null,
    authorProfileId: authorProfile,
    collaboratorProfileId: collaboratorProfile,
    contribution: invite().contribution,
    id: collaborationId,
    invitedAt: now,
    portfolioProjectId: projectId,
    revision: 1,
    role: invite().role,
    state: "PENDING",
    terminalAt: null,
    updatedAt: now,
    visibility: "VISIBLE",
    ...overrides,
  };
}

function identity() {
  return {
    authorProfileId: authorProfile,
    collaboratorProfileId: collaboratorProfile,
    portfolioProjectId: projectId,
  };
}

function profileLocks() {
  return [
    {
      accountState: "ACTIVE",
      ownerUserId: author,
      profileId: authorProfile,
    },
    {
      accountState: "ACTIVE",
      ownerUserId: collaborator,
      profileId: collaboratorProfile,
    },
  ];
}
