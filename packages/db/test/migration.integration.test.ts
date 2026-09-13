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
        applied: ["0000_enable_postgis.sql", "0001_create_users.sql"],
        alreadyApplied: 0,
      });

      const secondRun = await migratePostgres(
        testDatabaseUrl,
        migrationsDirectory,
      );
      expect(secondRun).toEqual({ applied: [], alreadyApplied: 2 });

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

        const [created] = await sql<
          {
            id: string;
            account_state: string;
            account_state_changed_at: Date;
            created_at: Date;
            updated_at: Date;
          }[]
        >`
          INSERT INTO users DEFAULT VALUES
          RETURNING
            id,
            account_state,
            account_state_changed_at,
            created_at,
            updated_at
        `;

        const [persisted] = await sql<{ id: string; account_state: string }[]>`
          SELECT id, account_state
          FROM users
          WHERE id = ${created!.id}
        `;

        const columns = await sql<{ column_name: string }[]>`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
          ORDER BY ordinal_position
        `;

        expect(postgis?.extversion).toMatch(/^3\./);
        expect(ledger?.count).toBe(2);
        expect(created).toMatchObject({ account_state: "ACTIVE" });
        expect(created?.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(created?.account_state_changed_at).toEqual(created?.created_at);
        expect(created?.updated_at).toEqual(created?.created_at);
        expect(persisted).toEqual({
          id: created?.id,
          account_state: "ACTIVE",
        });

        const retainedStates = await sql<{ account_state: string }[]>`
          INSERT INTO users (account_state)
          VALUES ('SUSPENDED'), ('DEACTIVATED')
          RETURNING account_state
        `;
        expect(
          retainedStates.map(({ account_state }) => account_state),
        ).toEqual(["SUSPENDED", "DEACTIVATED"]);

        expect(columns.map(({ column_name }) => column_name)).toEqual([
          "id",
          "account_state",
          "account_state_changed_at",
          "created_at",
          "updated_at",
        ]);

        await expect(
          sql`INSERT INTO users (account_state) VALUES (${"ADMIN"})`,
        ).rejects.toThrow();

        const createdAt = new Date("2026-09-14T00:00:00.000Z");
        const beforeCreation = new Date("2026-09-13T23:59:59.000Z");
        await expect(
          sql`
            INSERT INTO users (
              created_at,
              account_state_changed_at,
              updated_at
            ) VALUES (${createdAt}, ${beforeCreation}, ${createdAt})
          `,
        ).rejects.toThrow(/users_state_change_not_before_creation/);

        const beforeStateChange = new Date("2026-09-14T00:00:01.000Z");
        const stateChangedAt = new Date("2026-09-14T00:00:02.000Z");
        await expect(
          sql`
            INSERT INTO users (
              created_at,
              account_state_changed_at,
              updated_at
            ) VALUES (${createdAt}, ${stateChangedAt}, ${beforeStateChange})
          `,
        ).rejects.toThrow(/users_update_not_before_state_change/);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
);
