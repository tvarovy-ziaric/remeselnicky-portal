import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  createAuthRepository,
  type AuthRepository,
} from "./auth-repository.js";
import * as schema from "./schema/index.js";

export {
  authCredentials,
  authRateLimitBuckets,
  authSessions,
  passwordResetTokens,
  USER_ACCOUNT_STATE_VALUES,
  userAccountStateEnum,
  users,
} from "./schema/index.js";
export type {
  AuthCredentialRecord,
  AuthRateLimitBucketRecord,
  AuthSessionJsonValue,
  AuthSessionPayload,
  AuthSessionRecord,
  NewAuthCredentialRecord,
  NewAuthSessionRecord,
  NewPasswordResetTokenRecord,
  NewUserRecord,
  PasswordResetTokenRecord,
  UserRecord,
} from "./schema/index.js";

export { createAuthRepository } from "./auth-repository.js";
export type {
  AuthCredential,
  AuthRepository,
  AuthUser,
  ConsumePasswordResetResult,
  ConsumeRateLimitInput,
  CreatePasswordResetInput,
  PasswordResetRecord,
  PersistedAuthSession,
  RateLimitResult,
  RegisterAuthUserInput,
  RegisterAuthUserResult,
  SaveAuthSessionInput,
} from "./auth-repository.js";

export {
  createPostgresMigrationStore,
  loadMigrations,
  migratePostgres,
  MigrationValidationError,
  nodeMigrationFileSystem,
  runMigrations,
} from "./migrator.js";
export type {
  AppliedMigration,
  Migration,
  MigrationFileSystem,
  MigrationRunResult,
  MigrationStore,
  PostgresMigrationStoreOptions,
} from "./migrator.js";

export interface DatabaseHealthProbe {
  ping(): Promise<void>;
}

export interface DatabaseClient extends DatabaseHealthProbe {
  /**
   * Typed query entry point. Domain schemas are intentionally added by later
   * migration tickets rather than by the foundation package.
   */
  readonly query: PostgresJsDatabase<typeof schema>;
  readonly auth: AuthRepository;
  close(): Promise<void>;
}

export interface DatabaseConnectionOptions {
  readonly connectionString: string;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly maxConnections?: number;
}

export type HealthQueryExecutor = () => Promise<unknown>;

/** Creates an injectable probe without exposing connection details in results. */
export function createDatabaseHealthProbe(
  executeHealthQuery: HealthQueryExecutor,
): DatabaseHealthProbe {
  return Object.freeze({
    async ping(): Promise<void> {
      await executeHealthQuery();
    },
  });
}

/**
 * Opens a server-only PostgreSQL client. postgres-js parameterizes interpolated
 * values, while Drizzle is the public query layer for application code.
 */
export function createDatabase(
  options: DatabaseConnectionOptions,
): DatabaseClient {
  const sql = postgres(options.connectionString, {
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    max: options.maxConnections ?? 10,
    prepare: true,
  });
  const query = drizzle(sql, { schema });
  const auth = createAuthRepository(sql);
  const health = createDatabaseHealthProbe(async () => {
    await sql`select 1 as health`;
  });

  return Object.freeze({
    auth,
    query,
    ping(): Promise<void> {
      return health.ping();
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  });
}
