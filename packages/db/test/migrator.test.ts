import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  loadMigrations,
  MigrationValidationError,
  runMigrations,
  type AppliedMigration,
  type Migration,
  type MigrationFileSystem,
  type MigrationStore,
} from "../src/migrator.js";

function fakeFileSystem(
  files: Readonly<Record<string, string>>,
): MigrationFileSystem {
  return {
    list: vi.fn(() => Promise.resolve(Object.keys(files))),
    read: vi.fn((filePath: string) => {
      const contents = files[path.basename(filePath)];
      if (contents === undefined) {
        return Promise.reject(new Error(`Missing fixture ${filePath}`));
      }
      return Promise.resolve(contents);
    }),
  };
}

function fakeStore(existing: readonly AppliedMigration[] = []): {
  readonly store: MigrationStore;
  readonly calls: string[];
  readonly applied: Migration[];
} {
  const calls: string[] = [];
  const applied: Migration[] = [];

  return {
    calls,
    applied,
    store: {
      async withLock<T>(operation: () => Promise<T>): Promise<T> {
        calls.push("lock");
        try {
          return await operation();
        } finally {
          calls.push("unlock");
        }
      },
      prepare(): Promise<void> {
        calls.push("prepare");
        return Promise.resolve();
      },
      applied(): Promise<readonly AppliedMigration[]> {
        calls.push("read-ledger");
        return Promise.resolve(existing);
      },
      apply(migration: Migration): Promise<void> {
        calls.push(`apply:${migration.fileName}`);
        applied.push(migration);
        return Promise.resolve();
      },
    },
  };
}

describe("migration discovery", () => {
  it("loads normalized SQL in deterministic numeric order with stable checksums", async () => {
    const fs = fakeFileSystem({
      "0001_add_ledger.sql": "SELECT 2;\r\n",
      "0000_enable_postgis.sql": "\uFEFFSELECT 1;\r\n",
    });

    const migrations = await loadMigrations("fixtures", fs);

    expect(migrations.map(({ fileName }) => fileName)).toEqual([
      "0000_enable_postgis.sql",
      "0001_add_ledger.sql",
    ]);
    expect(migrations[0]?.sql).toBe("SELECT 1;\n");
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[0]?.checksum).not.toBe(migrations[1]?.checksum);
  });

  it.each([
    [{ "migration.sql": "SELECT 1;" }, "Invalid migration filename"],
    [{ "0001_first.sql": "SELECT 1;" }, "expected 0000, found 0001"],
    [
      { "0000_first.sql": "SELECT 1;", "0002_third.sql": "SELECT 3;" },
      "expected 0001, found 0002",
    ],
    [{ "0000_empty.sql": "  \n" }, "Migration is empty"],
  ])("rejects invalid migration sets", async (files, message) => {
    await expect(
      loadMigrations("fixtures", fakeFileSystem(files)),
    ).rejects.toThrow(message);
  });
});

describe("migration execution", () => {
  it("runs only the unapplied suffix while holding the lock", async () => {
    const migrations = await loadMigrations(
      "fixtures",
      fakeFileSystem({
        "0000_first.sql": "SELECT 1;",
        "0001_second.sql": "SELECT 2;",
      }),
    );
    const fixture = fakeStore([
      {
        version: migrations[0]!.version,
        name: migrations[0]!.name,
        checksum: migrations[0]!.checksum,
      },
    ]);

    await expect(runMigrations(fixture.store, migrations)).resolves.toEqual({
      applied: ["0001_second.sql"],
      alreadyApplied: 1,
    });
    expect(fixture.calls).toEqual([
      "lock",
      "prepare",
      "read-ledger",
      "apply:0001_second.sql",
      "unlock",
    ]);
  });

  it("stops before executing SQL when an applied migration was modified", async () => {
    const migrations = await loadMigrations(
      "fixtures",
      fakeFileSystem({ "0000_first.sql": "SELECT 1;" }),
    );
    const fixture = fakeStore([
      { version: 0, name: "first", checksum: "0".repeat(64) },
    ]);

    await expect(runMigrations(fixture.store, migrations)).rejects.toThrow(
      /Checksum mismatch.*immutable/,
    );
    expect(fixture.applied).toHaveLength(0);
    expect(fixture.calls.at(-1)).toBe("unlock");
  });

  it("rejects an out-of-order ledger before executing SQL", async () => {
    const migrations = await loadMigrations(
      "fixtures",
      fakeFileSystem({
        "0000_first.sql": "SELECT 1;",
        "0001_second.sql": "SELECT 2;",
      }),
    );
    const fixture = fakeStore([
      {
        version: migrations[1]!.version,
        name: migrations[1]!.name,
        checksum: migrations[1]!.checksum,
      },
    ]);

    await expect(
      runMigrations(fixture.store, migrations),
    ).rejects.toBeInstanceOf(MigrationValidationError);
    expect(fixture.applied).toHaveLength(0);
  });

  it("rejects a database migration absent from the repository", async () => {
    const migrations = await loadMigrations(
      "fixtures",
      fakeFileSystem({ "0000_first.sql": "SELECT 1;" }),
    );
    const fixture = fakeStore([
      {
        version: migrations[0]!.version,
        name: migrations[0]!.name,
        checksum: migrations[0]!.checksum,
      },
      { version: 1, name: "removed", checksum: "a".repeat(64) },
    ]);

    await expect(runMigrations(fixture.store, migrations)).rejects.toThrow(
      "Database contains unknown migration 0001_removed",
    );
    expect(fixture.applied).toHaveLength(0);
  });
});
