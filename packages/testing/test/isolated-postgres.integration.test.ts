import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { withIsolatedPostgresDatabase } from "../src/isolated-postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(connectionString === undefined)(
  "isolated PostgreSQL integration database",
  () => {
    it("creates a marked database for one run and removes it afterwards", async () => {
      if (connectionString === undefined) throw new Error("unreachable");
      let isolatedName = "";
      await withIsolatedPostgresDatabase({
        baseConnectionString: connectionString,
        environment: "test",
        async run({ databaseName, environment, sql }) {
          isolatedName = databaseName;
          const [state] = await sql<
            { readonly database: string; readonly environment: string }[]
          >`
            SELECT
              current_database() AS database,
              current_setting('portal.environment', true) AS environment
          `;
          expect(state).toEqual({ database: databaseName, environment });
          await sql`CREATE TABLE isolated_probe (id integer PRIMARY KEY)`;
          await sql`INSERT INTO isolated_probe (id) VALUES (1)`;
        },
      });

      const base = postgres(connectionString, { max: 1, prepare: true });
      try {
        const [remaining] = await base<{ readonly count: number }[]>`
          SELECT count(*)::integer AS count
          FROM pg_database
          WHERE datname = ${isolatedName}
        `;
        expect(remaining?.count).toBe(0);
      } finally {
        await base.end({ timeout: 5 });
      }
    });

    it("uses a distinct database for every run", async () => {
      if (connectionString === undefined) throw new Error("unreachable");
      const names = await Promise.all(
        [0, 1].map(() =>
          withIsolatedPostgresDatabase({
            baseConnectionString: connectionString,
            environment: "test",
            run: ({ databaseName }) => Promise.resolve(databaseName),
          }),
        ),
      );
      expect(new Set(names).size).toBe(2);
    });

    it("removes the generated database when the test callback throws", async () => {
      if (connectionString === undefined) throw new Error("unreachable");
      let isolatedName = "";
      await expect(
        withIsolatedPostgresDatabase({
          baseConnectionString: connectionString,
          environment: "test",
          run: ({ databaseName }) => {
            isolatedName = databaseName;
            throw new Error("synthetic callback failure");
          },
        }),
      ).rejects.toThrow("synthetic callback failure");

      const base = postgres(connectionString, { max: 1, prepare: true });
      try {
        const [remaining] = await base<{ readonly count: number }[]>`
          SELECT count(*)::integer AS count
          FROM pg_database
          WHERE datname = ${isolatedName}
        `;
        expect(remaining?.count).toBe(0);
      } finally {
        await base.end({ timeout: 5 });
      }
    });
  },
);
