import { createHash } from "node:crypto";

import type {
  AddIndicativePricingEntryInput,
  CraftsmanProfileId,
  IndicativePricingEntryId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createIndicativePricingRepository,
  IndicativePricingIdempotencyError,
} from "../src/indicative-pricing-repository.js";

const actorUserId = "49000000-0000-4000-8000-000000000001" as UserId;
const otherUserId = "49000000-0000-4000-8000-000000000002" as UserId;
const craftsmanProfileId =
  "49000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const entryId =
  "49000000-0000-4000-8000-000000000004" as IndicativePricingEntryId;
const commandId = "49000000-0000-4000-8000-000000000005";

describe("indicative pricing repository", () => {
  it("fails closed for a non-owner before reading pricing data", async () => {
    const sql = scriptedSql([[ownedProfile(actorUserId)]]);
    const repository = createIndicativePricingRepository(sql);

    await expect(
      repository.add({ ...addInput(), actorUserId: otherUserId }),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toMatch(/FOR UPDATE OF profile, owner/u);
  });

  it("adds an unforced-taxonomy row with command and initial snapshot", async () => {
    const sql = scriptedSql([
      [ownedProfile()],
      [],
      [],
      [],
      [],
      [],
      [entryRow()],
    ]);
    const result = await createIndicativePricingRepository(sql).add(addInput());

    expect(result).toMatchObject({
      entry: {
        amountCents: 12_500,
        craftsmanProfessionId: null,
        currency: "EUR",
        state: "ACTIVE",
      },
      status: "APPLIED",
    });
    expect(sql.queries.join("\n")).toMatch(
      /INSERT INTO indicative_pricing_entries[\s\S]*INSERT INTO indicative_pricing_commands[\s\S]*INSERT INTO indicative_pricing_entry_revisions/u,
    );
  });

  it("returns the immutable command snapshot for an exact replay", async () => {
    const input = addInput();
    const replay = {
      ...entryRow(),
      actorUserId,
      commandKind: "ADD",
      commandProfileId: craftsmanProfileId,
      entryId,
      payloadFingerprint: fingerprint("ADD", input),
    };
    const exact = scriptedSql([[ownedProfile()], [replay]]);
    const replayResult =
      await createIndicativePricingRepository(exact).add(input);
    expect(replayResult).toMatchObject({
      entry: { revision: 1 },
      status: "DEDUPLICATED",
    });
    if (!("entry" in replayResult)) {
      throw new Error("Expected replay entry.");
    }
    expect(replayResult.entry).not.toHaveProperty("payloadFingerprint");
    expect(replayResult.entry).not.toHaveProperty("actorUserId");

    const conflict = scriptedSql([
      [ownedProfile()],
      [{ ...replay, payloadFingerprint: "f".repeat(64) }],
    ]);
    await expect(
      createIndicativePricingRepository(conflict).add(input),
    ).rejects.toThrow(IndicativePricingIdempotencyError);
  });

  it("uses revision CAS, detects no-op edits and archives without deletion", async () => {
    const editInput = {
      actorUserId,
      amountCents: 20_000,
      commandId: "49000000-0000-4000-8000-000000000006",
      craftsmanProfessionId: null,
      craftsmanProfileId,
      entryId,
      expectedRevision: 1,
      note: null,
      priceMode: "APPROXIMATE" as const,
      serviceName: "Montáž batérie",
    };
    const stale = scriptedSql([
      [ownedProfile()],
      [],
      [{ ...entryRow(), revision: 2 }],
    ]);
    await expect(
      createIndicativePricingRepository(stale).edit(editInput),
    ).resolves.toEqual({ status: "STALE_REVISION" });

    const unchanged = scriptedSql([[ownedProfile()], [], [entryRow()]]);
    await expect(
      createIndicativePricingRepository(unchanged).edit({
        ...editInput,
        amountCents: 12_500,
        priceMode: "FROM",
        serviceName: "Montáž batérie",
      }),
    ).resolves.toEqual({ status: "UNCHANGED" });

    const archivedAt = new Date("2026-09-14T08:01:00.000Z");
    const archive = scriptedSql([
      [ownedProfile()],
      [],
      [entryRow()],
      [],
      [],
      [],
      [entryRow({ archivedAt, revision: 2, state: "ARCHIVED" })],
    ]);
    await expect(
      createIndicativePricingRepository(archive).archive({
        actorUserId,
        commandId: "49000000-0000-4000-8000-000000000007",
        craftsmanProfileId,
        entryId,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      entry: { archivedAt, state: "ARCHIVED" },
      status: "APPLIED",
    });
    expect(archive.queries.join("\n")).not.toMatch(
      /DELETE FROM indicative_pricing/u,
    );
  });

  it("lists only through active owner scope in deterministic order", async () => {
    const sql = scriptedSql([[ownedProfile()], [entryRow()]]);
    await expect(
      createIndicativePricingRepository(sql).listOwned({
        actorUserId,
        craftsmanProfileId,
      }),
    ).resolves.toHaveLength(1);
    expect(sql.queries[1]).toMatch(/state = 'ACTIVE'/u);
    expect(sql.queries[1]).toMatch(/ORDER BY created_at, id/u);
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

function addInput(): AddIndicativePricingEntryInput {
  return {
    actorUserId,
    amountCents: 12_500,
    commandId,
    craftsmanProfileId,
    entryId,
    note: null,
    priceMode: "FROM",
    serviceName: "Montáž batérie",
  };
}

function ownedProfile(ownerUserId = actorUserId) {
  return { accountState: "ACTIVE", ownerUserId };
}

function entryRow(
  input: {
    readonly archivedAt?: Date | null;
    readonly revision?: number;
    readonly state?: "ACTIVE" | "ARCHIVED";
  } = {},
) {
  const createdAt = new Date("2026-09-14T08:00:00.000Z");
  return {
    amountCents: "12500",
    archivedAt: input.archivedAt ?? null,
    craftsmanProfessionId: null,
    craftsmanProfileId,
    createdAt,
    currency: "EUR",
    id: entryId,
    note: null,
    priceMode: "FROM",
    revision: input.revision ?? 1,
    serviceName: "Montáž batérie",
    state: input.state ?? "ACTIVE",
    updatedAt: input.archivedAt ?? createdAt,
  };
}

function fingerprint(
  kind: "ADD",
  input: AddIndicativePricingEntryInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        input.commandId,
        input.entryId,
        input.craftsmanProfileId,
        input.actorUserId,
        null,
        input.craftsmanProfessionId ?? null,
        input.serviceName,
        input.priceMode,
        input.amountCents,
        input.note ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}
