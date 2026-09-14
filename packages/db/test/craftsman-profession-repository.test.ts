import { createHash } from "node:crypto";

import type {
  AssignCraftsmanProfessionInput,
  CraftsmanProfessionId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanProfessionRepository,
  CraftsmanProfessionIdempotencyError,
} from "../src/craftsman-profession-repository.js";

const ownerUserId = "41000000-0000-4000-8000-000000000001" as UserId;
const nonOwnerUserId = "41000000-0000-4000-8000-000000000002" as UserId;
const craftsmanProfileId =
  "41000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const craftsmanProfessionId =
  "41000000-0000-4000-8000-000000000004" as CraftsmanProfessionId;
const taxonomyReleaseId = "41000000-0000-4000-8000-000000000005";
const commandId = "41000000-0000-4000-8000-000000000006";

describe("craftsman profession repository", () => {
  it("fails closed for a non-owner without querying taxonomy or assignment data", async () => {
    const sql = scriptedSql([[{ accountState: "ACTIVE", ownerUserId }]]);
    const repository = createCraftsmanProfessionRepository(sql);

    await expect(
      repository.assign({ ...assignment(), actorUserId: nonOwnerUserId }),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
  });

  it("rejects stale releases and deprecated current professions", async () => {
    const staleSql = scriptedSql([
      [ownedProfile()],
      [],
      [{ currentReleaseId: "41000000-0000-4000-8000-000000000099" }],
    ]);
    await expect(
      createCraftsmanProfessionRepository(staleSql).assign(assignment()),
    ).resolves.toEqual({ status: "TAXONOMY_RELEASE_NOT_CURRENT" });

    const deprecatedSql = scriptedSql([
      [ownedProfile()],
      [],
      [{ currentReleaseId: taxonomyReleaseId }],
      [{ state: "DEPRECATED" }],
    ]);
    await expect(
      createCraftsmanProfessionRepository(deprecatedSql).assign(assignment()),
    ).resolves.toEqual({ status: "PROFESSION_NOT_ACTIVE" });
  });

  it("writes one transactional assignment, command and initial declared event", async () => {
    const sql = scriptedSql([
      [ownedProfile()],
      [],
      [{ currentReleaseId: taxonomyReleaseId }],
      [{ state: "ACTIVE" }],
      [],
      [],
      [],
      [],
      [professionRow()],
    ]);
    const repository = createCraftsmanProfessionRepository(sql);

    await expect(repository.assign(assignment())).resolves.toMatchObject({
      profession: {
        declaredLevel: "BEGINNER",
        evidenceSupportedLevel: null,
      },
      status: "APPLIED",
    });
    expect(sql.queries.join("\n")).toMatch(
      /INSERT INTO craftsman_professions[\s\S]*INSERT INTO craftsman_profession_commands[\s\S]*INSERT INTO craftsman_profession_declared_level_events/u,
    );
    expect(
      sql.queries
        .filter((statement) => statement.includes("INSERT INTO"))
        .join("\n"),
    ).not.toMatch(/evidence_supported_level/u);
  });

  it("deduplicates an exact command and rejects command-id intent reuse", async () => {
    const input = assignment();
    const replay = commandRow("ASSIGN", fingerprint("ASSIGN", input));
    const exactSql = scriptedSql([
      [ownedProfile()],
      [replay],
      [professionRow()],
    ]);
    await expect(
      createCraftsmanProfessionRepository(exactSql).assign(input),
    ).resolves.toMatchObject({ status: "DEDUPLICATED" });

    const conflictSql = scriptedSql([
      [ownedProfile()],
      [commandRow("ASSIGN", "f".repeat(64))],
    ]);
    await expect(
      createCraftsmanProfessionRepository(conflictSql).assign(input),
    ).rejects.toThrow(CraftsmanProfessionIdempotencyError);
  });

  it("uses optimistic history revisions and rejects no-op level changes", async () => {
    const staleSql = scriptedSql([
      [ownedProfile()],
      [],
      [assignmentState("BEGINNER", 2)],
    ]);
    const change = {
      actorUserId: ownerUserId,
      commandId: "41000000-0000-4000-8000-000000000007",
      craftsmanProfessionId,
      craftsmanProfileId,
      declaredLevel: "ADVANCED" as const,
      expectedDeclaredLevelRevision: 1,
    };
    await expect(
      createCraftsmanProfessionRepository(staleSql).changeDeclaredLevel(change),
    ).resolves.toEqual({ status: "STALE_REVISION" });

    const unchangedSql = scriptedSql([
      [ownedProfile()],
      [],
      [assignmentState("ADVANCED", 1)],
    ]);
    await expect(
      createCraftsmanProfessionRepository(unchangedSql).changeDeclaredLevel(
        change,
      ),
    ).resolves.toEqual({ status: "LEVEL_UNCHANGED" });
  });

  it("deactivates through explicit command provenance and never deletes", async () => {
    const deactivationId = "41000000-0000-4000-8000-000000000008";
    const sql = scriptedSql([
      [ownedProfile()],
      [],
      [{ state: "ACTIVE" }],
      [],
      [],
      [professionRow({ deactivated: true })],
    ]);
    await expect(
      createCraftsmanProfessionRepository(sql).deactivate({
        actorUserId: ownerUserId,
        commandId: deactivationId,
        craftsmanProfessionId,
        craftsmanProfileId,
      }),
    ).resolves.toMatchObject({
      profession: { state: "INACTIVE" },
      status: "APPLIED",
    });
    const statements = sql.queries.join("\n");
    expect(statements).toMatch(
      /command_kind[\s\S]*UPDATE craftsman_professions/u,
    );
    expect(statements).toMatch(/deactivation_command_id/u);
    expect(statements).not.toMatch(/DELETE FROM craftsman_professions/u);
  });

  it("fuses active-owner authorization into the private list query", async () => {
    const sql = scriptedSql([[professionRow()]]);
    await expect(
      createCraftsmanProfessionRepository(sql).listOwned({
        actorUserId: ownerUserId,
        craftsmanProfileId,
      }),
    ).resolves.toHaveLength(1);
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toMatch(
      /FROM current_craftsman_professions current[\s\S]*JOIN users owner[\s\S]*profile\.owner_user_id[\s\S]*owner\.account_state = 'ACTIVE'/u,
    );

    const suspended = scriptedSql([[]]);
    await expect(
      createCraftsmanProfessionRepository(suspended).listOwned({
        actorUserId: ownerUserId,
        craftsmanProfileId,
      }),
    ).resolves.toEqual([]);
    expect(suspended.queries).toHaveLength(1);
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

function assignment(): AssignCraftsmanProfessionInput {
  return {
    actorUserId: ownerUserId,
    commandId,
    craftsmanProfessionId,
    craftsmanProfileId,
    declaredLevel: "BEGINNER",
    professionCode: "PROF:INTEGRATION_ALPHA",
    taxonomyReleaseId,
  };
}

function ownedProfile() {
  return { accountState: "ACTIVE", ownerUserId };
}

function assignmentState(
  declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER",
  declaredLevelRevision: number,
) {
  return { declaredLevel, declaredLevelRevision, state: "ACTIVE" };
}

function commandRow(kind: "ASSIGN", payloadFingerprint: string) {
  return {
    actorUserId: ownerUserId,
    commandId,
    commandKind: kind,
    craftsmanProfessionId,
    craftsmanProfileId,
    payloadFingerprint,
  };
}

function professionRow(input: { readonly deactivated?: boolean } = {}) {
  const createdAt = new Date("2026-09-14T06:00:00.000Z");
  return {
    craftsmanProfileId,
    createdAt,
    deactivatedAt: input.deactivated
      ? new Date("2026-09-14T07:00:00.000Z")
      : null,
    declaredLevel: "BEGINNER",
    declaredLevelChangedAt: createdAt,
    declaredLevelRevision: 1,
    evidenceSupportedAt: null,
    evidenceSupportedLevel: null,
    id: craftsmanProfessionId,
    professionCode: "PROF:INTEGRATION_ALPHA",
    state: input.deactivated ? "INACTIVE" : "ACTIVE",
    taxonomyReleaseId,
  };
}

function fingerprint(
  kind: "ASSIGN",
  input: AssignCraftsmanProfessionInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        input.commandId,
        input.craftsmanProfessionId,
        input.craftsmanProfileId,
        input.actorUserId,
        input.taxonomyReleaseId,
        input.professionCode,
        null,
        input.declaredLevel,
      ]),
      "utf8",
    )
    .digest("hex");
}
