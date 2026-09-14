import type {
  SeedCredentialHashProvider,
  SyntheticSeedCatalog,
  SyntheticSeedPersistence,
  SyntheticSeedReport,
} from "./model.js";

type AllowedSeedEnvironment = "development" | "staging" | "test";

export async function applySyntheticSeedCatalog(input: {
  readonly catalog: SyntheticSeedCatalog;
  readonly credentialHashes: SeedCredentialHashProvider;
  readonly environment: string | undefined;
  readonly persistence: SyntheticSeedPersistence;
}): Promise<SyntheticSeedReport> {
  const environment = parseAllowedEnvironment(input.environment);
  if (input.catalog.synthetic !== true || input.catalog.schemaVersion !== 1) {
    throw new TypeError(
      "Only a versioned synthetic seed catalog may be applied.",
    );
  }
  if (input.credentialHashes.kind !== "TEST_ONLY_HASH_PROVIDER") {
    throw new TypeError(
      "Synthetic seeds require an explicit test-only hash provider.",
    );
  }

  // The DB-side marker is checked before the first credential hash is requested.
  await input.persistence.assertTargetEnvironment(environment);

  let created = 0;
  let unchanged = 0;
  for (const account of input.catalog.accounts) {
    assertSyntheticAccount(account.synthetic, account.analyticsActor.is_test);
    const passwordHash = await input.credentialHashes.passwordHashFor(
      account.fixtureId,
    );
    assertInjectedPasswordHash(passwordHash);
    const result = await input.persistence.upsertAccount({
      account,
      passwordHash,
    });
    if (result === "CREATED") created += 1;
    else unchanged += 1;
  }
  return Object.freeze({ created, environment, unchanged });
}

export function parseAllowedEnvironment(
  value: string | undefined,
): AllowedSeedEnvironment {
  if (value === "development" || value === "staging" || value === "test") {
    return value;
  }
  throw new Error(
    "Synthetic seed execution is allowed only in development, staging or test.",
  );
}

function assertSyntheticAccount(synthetic: true, analyticsIsTest: true): void {
  if (synthetic !== true || analyticsIsTest !== true) {
    throw new TypeError(
      "Every seeded account must be synthetic and analytics-test tagged.",
    );
  }
}

function assertInjectedPasswordHash(value: string): void {
  if (value.length < 20 || value.length > 1024 || /\s/u.test(value)) {
    throw new TypeError(
      "Injected password hash must be opaque, bounded and whitespace-free.",
    );
  }
}
