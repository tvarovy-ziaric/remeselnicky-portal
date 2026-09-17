import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres, { type ReservedSql, type Sql } from "postgres";

const MIGRATION_FILE = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/;
const MIGRATION_LOCK_ID = 7_246_771_036;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationFileSystem {
  list(directory: string): Promise<readonly string[]>;
  read(filePath: string): Promise<string>;
}

export interface MigrationStore {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  prepare(): Promise<void>;
  applied(): Promise<readonly AppliedMigration[]>;
  apply(migration: Migration): Promise<void>;
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

export class MigrationValidationError extends Error {
  override readonly name = "MigrationValidationError";
}

export const nodeMigrationFileSystem: MigrationFileSystem = Object.freeze({
  list(directory: string): Promise<readonly string[]> {
    return readdir(directory);
  },
  read(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  },
});

export async function loadMigrations(
  directory: string,
  fileSystem: MigrationFileSystem = nodeMigrationFileSystem,
): Promise<readonly Migration[]> {
  const fileNames = (await fileSystem.list(directory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const migrations = await Promise.all(
    fileNames.map(async (fileName): Promise<Migration> => {
      const match = MIGRATION_FILE.exec(fileName);
      if (match === null) {
        throw new MigrationValidationError(
          `Invalid migration filename: ${fileName}. Expected NNNN_snake_case.sql.`,
        );
      }

      const versionText = match[1];
      const name = match[2];
      if (versionText === undefined || name === undefined) {
        throw new MigrationValidationError(
          `Cannot parse migration: ${fileName}.`,
        );
      }

      const sql = normalizeSql(
        await fileSystem.read(path.join(directory, fileName)),
      );
      if (sql.trim().length === 0) {
        throw new MigrationValidationError(`Migration is empty: ${fileName}.`);
      }

      return Object.freeze({
        version: Number.parseInt(versionText, 10),
        name,
        fileName,
        checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
        sql,
      });
    }),
  );

  migrations.forEach((migration, index) => {
    if (migration.version !== index) {
      throw new MigrationValidationError(
        `Migration sequence must be contiguous from 0000; expected ${formatVersion(index)}, found ${formatVersion(migration.version)}.`,
      );
    }
  });

  return Object.freeze(migrations);
}

export async function runMigrations(
  store: MigrationStore,
  migrations: readonly Migration[],
): Promise<MigrationRunResult> {
  return store.withLock(async () => {
    await store.prepare();
    const applied = [...(await store.applied())].sort(
      (left, right) => left.version - right.version,
    );

    validateAppliedPrefix(migrations, applied);

    const pending = migrations.slice(applied.length);
    for (const migration of pending) {
      await store.apply(migration);
    }

    return Object.freeze({
      applied: Object.freeze(pending.map(({ fileName }) => fileName)),
      alreadyApplied: applied.length,
    });
  });
}

export interface PostgresMigrationStoreOptions {
  readonly lockId?: number;
}

/**
 * Creates the production migration adapter. A session advisory lock prevents
 * concurrent runners while each migration and its ledger entry commit in their
 * own transaction. PostgreSQL enum additions must commit before later
 * migrations can use the new values.
 */
export function createPostgresMigrationStore(
  sql: Sql,
  options: PostgresMigrationStoreOptions = {},
): MigrationStore {
  const lockId = options.lockId ?? MIGRATION_LOCK_ID;
  let lockedConnection: ReservedSql | undefined;

  function connection(): ReservedSql {
    if (lockedConnection === undefined) {
      throw new Error("Migration store must be used inside withLock().");
    }
    return lockedConnection;
  }

  return Object.freeze({
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      if (lockedConnection !== undefined) {
        throw new Error(
          "Concurrent use of one migration store is not supported.",
        );
      }

      const reserved = await sql.reserve();
      let acquired = false;
      try {
        await reserved`SELECT pg_advisory_lock(${lockId})`;
        acquired = true;
        lockedConnection = reserved;
        return await operation();
      } finally {
        lockedConnection = undefined;
        try {
          if (acquired) {
            await reserved`SELECT pg_advisory_unlock(${lockId})`;
          }
        } finally {
          reserved.release();
        }
      }
    },

    async prepare(): Promise<void> {
      await connection().unsafe(`
        CREATE TABLE IF NOT EXISTS portal_schema_migrations (
          version integer PRIMARY KEY CHECK (version >= 0),
          name text NOT NULL UNIQUE,
          checksum character(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },

    async applied(): Promise<readonly AppliedMigration[]> {
      const rows = await connection()<AppliedMigration[]>`
        SELECT version, name, checksum
        FROM portal_schema_migrations
        ORDER BY version ASC
      `;
      return rows;
    },

    async apply(migration: Migration): Promise<void> {
      const reserved = connection();
      await reserved.unsafe("BEGIN");
      try {
        await reserved.unsafe(stripOuterTransaction(migration.sql));
        await reserved`
          INSERT INTO portal_schema_migrations (version, name, checksum)
          VALUES (${migration.version}, ${migration.name}, ${migration.checksum})
        `;
        await reserved.unsafe("COMMIT");
      } catch (error) {
        await reserved.unsafe("ROLLBACK");
        throw error;
      }
    },
  });
}

export async function migratePostgres(
  connectionString: string,
  directory: string,
): Promise<MigrationRunResult> {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: true,
    onnotice: () => undefined,
  });

  try {
    const migrations = await loadMigrations(directory);
    return await runMigrations(createPostgresMigrationStore(sql), migrations);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function validateAppliedPrefix(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): void {
  applied.forEach((record, index) => {
    const migration = migrations[index];
    if (migration === undefined) {
      throw new MigrationValidationError(
        `Database contains unknown migration ${formatVersion(record.version)}_${record.name}.`,
      );
    }
    if (
      record.version !== migration.version ||
      record.name !== migration.name
    ) {
      throw new MigrationValidationError(
        `Database migration ${formatVersion(record.version)}_${record.name} does not match repository migration ${migration.fileName}.`,
      );
    }
    if (record.checksum !== migration.checksum) {
      throw new MigrationValidationError(
        `Checksum mismatch for applied migration ${migration.fileName}; applied migrations are immutable.`,
      );
    }
  });
}

function stripOuterTransaction(sql: string): string {
  const match = /^\s*BEGIN\s*;([\s\S]*?)COMMIT\s*;\s*$/i.exec(sql);
  return match?.[1] ?? sql;
}

function normalizeSql(sql: string): string {
  return sql.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function formatVersion(version: number): string {
  return version.toString().padStart(4, "0");
}
