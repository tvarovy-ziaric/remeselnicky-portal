import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { migratePostgres } from "../src/migrator.js";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const migrationsDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

describe.skipIf(testDatabaseUrl === undefined)(
  "clean PostgreSQL/PostGIS migrations",
  () => {
    it("applies the complete migration set and is idempotent", async () => {
      if (testDatabaseUrl === undefined) {
        throw new Error("TEST_DATABASE_URL is required for integration tests");
      }

      const firstRun = await migratePostgres(
        testDatabaseUrl,
        migrationsDirectory,
      );
      expect(firstRun).toEqual({
        applied: ["0000_enable_postgis.sql"],
        alreadyApplied: 0,
      });

      const secondRun = await migratePostgres(
        testDatabaseUrl,
        migrationsDirectory,
      );
      expect(secondRun).toEqual({ applied: [], alreadyApplied: 1 });

      const sql = postgres(testDatabaseUrl, { max: 1 });
      try {
        const [postgis] = await sql<{ extversion: string }[]>`
          SELECT extversion
          FROM pg_extension
          WHERE extname = 'postgis'
        `;
        const [ledger] = await sql<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM portal_schema_migrations
        `;

        expect(postgis?.extversion).toMatch(/^3\./);
        expect(ledger?.count).toBe(1);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
);
