import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { migratePostgres } from "../src/migrator.js";
import { createAuthRepository } from "../src/index.js";

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
        applied: [
          "0000_enable_postgis.sql",
          "0001_create_users.sql",
          "0002_authentication.sql",
        ],
        alreadyApplied: 0,
      });

      const secondRun = await migratePostgres(
        testDatabaseUrl,
        migrationsDirectory,
      );
      expect(secondRun).toEqual({ applied: [], alreadyApplied: 3 });

      const sql = postgres(testDatabaseUrl, { max: 5 });
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
        expect(ledger?.count).toBe(3);
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

        const auth = createAuthRepository(sql);
        const unique = randomUUID();
        const normalizedEmail = `auth-${unique}@example.test`;
        const initialPasswordHash = `$argon2id$${"a".repeat(64)}`;
        const replacementPasswordHash = `$argon2id$${"b".repeat(64)}`;
        const beforeRegistration = new Date();
        const registration = await auth.registerUserWithCredential({
          adultAttested: true,
          normalizedEmail,
          passwordHash: initialPasswordHash,
        });
        expect(registration.status).toBe("CREATED");
        if (registration.status !== "CREATED") {
          throw new Error("Expected a newly registered authentication user.");
        }
        expect(
          registration.user.adultAttestedAt.valueOf(),
        ).toBeGreaterThanOrEqual(beforeRegistration.valueOf());
        expect(registration.user.adultAttestedAt.valueOf()).toBeLessThanOrEqual(
          Date.now(),
        );

        await expect(
          auth.registerUserWithCredential({
            adultAttested: true,
            normalizedEmail,
            passwordHash: initialPasswordHash,
          }),
        ).resolves.toEqual({ status: "DUPLICATE" });

        const credential =
          await auth.findCredentialByNormalizedEmail(normalizedEmail);
        expect(credential).toMatchObject({
          id: registration.user.id,
          accountState: "ACTIVE",
          normalizedEmail,
          passwordHash: initialPasswordHash,
        });
        await expect(
          auth.findAuthUserById(registration.user.id),
        ).resolves.toMatchObject({
          id: registration.user.id,
          accountState: "ACTIVE",
        });

        const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
        const sessionDigests = [
          digest(`session-a-${unique}`),
          digest(`session-b-${unique}`),
        ];
        for (const sessionIdHash of sessionDigests) {
          await expect(
            auth.saveSession({
              sessionIdHash,
              userId: registration.user.id,
              payload: { userId: registration.user.id },
              expiresAt: sessionExpiresAt,
            }),
          ).resolves.toMatchObject({ sessionIdHash });
        }
        await expect(
          auth.findSession(sessionDigests[0]!),
        ).resolves.toMatchObject({ userId: registration.user.id });

        const competingTokenDigests = [
          digest(`reset-a-${unique}`),
          digest(`reset-b-${unique}`),
        ];
        await Promise.all(
          competingTokenDigests.map(async (tokenDigest) =>
            auth.createPasswordReset({
              userId: registration.user.id,
              tokenDigest,
              expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
            }),
          ),
        );
        const liveResetTokens = await sql<{ tokenDigest: string }[]>`
          SELECT token_digest AS "tokenDigest"
          FROM password_reset_tokens
          WHERE user_id = ${registration.user.id}
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
        `;
        expect(liveResetTokens).toHaveLength(1);
        const tokenDigest = liveResetTokens[0]!.tokenDigest;

        const resetAttempts = await Promise.all([
          auth.consumePasswordReset(tokenDigest, replacementPasswordHash),
          auth.consumePasswordReset(tokenDigest, replacementPasswordHash),
        ]);
        expect(
          resetAttempts.filter(({ status }) => status === "SUCCESS"),
        ).toHaveLength(1);
        expect(
          resetAttempts.filter(({ status }) => status === "INVALID"),
        ).toHaveLength(1);
        expect(
          resetAttempts.find(({ status }) => status === "SUCCESS"),
        ).toMatchObject({
          revokedSessionCount: 2,
          status: "SUCCESS",
          userId: registration.user.id,
        });
        await expect(
          auth.consumePasswordReset(tokenDigest, replacementPasswordHash),
        ).resolves.toEqual({ status: "INVALID" });
        await expect(auth.findSession(sessionDigests[0]!)).resolves.toBeNull();
        await expect(auth.findSession(sessionDigests[1]!)).resolves.toBeNull();
        await expect(
          auth.findCredentialByNormalizedEmail(normalizedEmail),
        ).resolves.toMatchObject({ passwordHash: replacementPasswordHash });

        const rateInput = {
          scope: "login",
          keyDigest: digest(`rate-${unique}`),
          windowStartedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          limit: 3,
        } as const;
        const rateResults = await Promise.all([
          auth.consumeRateLimit(rateInput),
          auth.consumeRateLimit(rateInput),
          auth.consumeRateLimit(rateInput),
          auth.consumeRateLimit(rateInput),
        ]);
        expect(
          rateResults
            .map(({ attemptCount }) => attemptCount)
            .sort((a, b) => a - b),
        ).toEqual([1, 2, 3, 4]);
        expect(rateResults.filter(({ allowed }) => allowed)).toHaveLength(3);

        await expect(
          sql`
            INSERT INTO auth_sessions (
              session_id_hash,
              user_id,
              payload,
              expires_at
            ) VALUES (
              ${"not-a-digest"},
              ${registration.user.id},
              ${sql.json({})},
              ${sessionExpiresAt}
            )
          `,
        ).rejects.toThrow();
        await expect(
          sql`
            INSERT INTO auth_sessions (
              session_id_hash,
              user_id,
              payload,
              expires_at
            ) VALUES (
              ${digest(`invalid-payload-${unique}`)},
              ${registration.user.id},
              ${sql.json([])},
              ${sessionExpiresAt}
            )
          `,
        ).rejects.toThrow(/auth_sessions_payload_is_object/);
        await expect(
          sql`
            INSERT INTO password_reset_tokens (
              user_id,
              token_digest,
              expires_at,
              consumed_at,
              invalidated_at
            ) VALUES (
              ${registration.user.id},
              ${digest(`terminal-state-${unique}`)},
              ${sessionExpiresAt},
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
          `,
        ).rejects.toThrow(/password_reset_tokens_one_terminal_state/);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
);

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
