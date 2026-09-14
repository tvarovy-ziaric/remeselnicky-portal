import {
  PLACEHOLDER_PROFESSION_TAXONOMY,
  SYNTHETIC_SLOVAK_LOCATIONS,
} from "./catalog.js";
import type {
  SyntheticAccountFixture,
  SyntheticAccountKind,
  SyntheticProfileCapabilities,
  SyntheticSeedCatalog,
} from "./model.js";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

const definitions = Object.freeze({
  CUSTOMER: definition("CUSTOMER", "00000000-0000-4000-8000-000000000101", {
    customer: true,
    craftsman: false,
    craftsmanProfileKind: null,
  }),
  CRAFTSMAN_INDIVIDUAL: definition(
    "CRAFTSMAN_INDIVIDUAL",
    "00000000-0000-4000-8000-000000000102",
    { customer: false, craftsman: true, craftsmanProfileKind: "INDIVIDUAL" },
  ),
  CRAFTSMAN_COMPANY: definition(
    "CRAFTSMAN_COMPANY",
    "00000000-0000-4000-8000-000000000103",
    { customer: false, craftsman: true, craftsmanProfileKind: "COMPANY" },
  ),
  COMBINED: definition("COMBINED", "00000000-0000-4000-8000-000000000104", {
    customer: true,
    craftsman: true,
    craftsmanProfileKind: "INDIVIDUAL",
  }),
  ADMIN: definition(
    "ADMIN",
    "00000000-0000-4000-8000-000000000105",
    { customer: false, craftsman: false, craftsmanProfileKind: null },
    "ADMIN",
  ),
  SUPERADMIN: definition(
    "SUPERADMIN",
    "00000000-0000-4000-8000-000000000106",
    { customer: false, craftsman: false, craftsmanProfileKind: null },
    "SUPER_ADMIN",
  ),
  SUSPENDED: definition(
    "SUSPENDED",
    "00000000-0000-4000-8000-000000000107",
    { customer: true, craftsman: false, craftsmanProfileKind: null },
    null,
    "SUSPENDED",
  ),
} satisfies Record<SyntheticAccountKind, SyntheticAccountFixture>);

export function createSyntheticAccountFixture(
  accountKind: SyntheticAccountKind,
): SyntheticAccountFixture {
  const fixture = definitions[accountKind];
  return freezeFixture({
    ...fixture,
    adultAttestedAt: new Date(fixture.adultAttestedAt),
    analyticsActor: { ...fixture.analyticsActor },
    createdAt: new Date(fixture.createdAt),
    emailVerifiedAt: new Date(fixture.emailVerifiedAt),
    locationCodes: [...fixture.locationCodes],
    mfaFactor: fixture.mfaFactor === null ? null : { ...fixture.mfaFactor },
    phoneVerifiedAt: new Date(fixture.phoneVerifiedAt),
    professionCodes: [...fixture.professionCodes],
    profileCapabilities: { ...fixture.profileCapabilities },
  });
}

export function createSyntheticSeedCatalog(): SyntheticSeedCatalog {
  return Object.freeze({
    accounts: Object.freeze(
      (Object.keys(definitions) as SyntheticAccountKind[]).map((kind) =>
        createSyntheticAccountFixture(kind),
      ),
    ),
    locations: SYNTHETIC_SLOVAK_LOCATIONS,
    professions: PLACEHOLDER_PROFESSION_TAXONOMY,
    schemaVersion: 1,
    synthetic: true,
  });
}

function definition(
  accountKind: SyntheticAccountKind,
  userId: string,
  profileCapabilities: SyntheticProfileCapabilities,
  adminRole: SyntheticAccountFixture["adminRole"] = null,
  accountState: SyntheticAccountFixture["accountState"] = "ACTIVE",
): SyntheticAccountFixture {
  const slug = userId.slice(-3);
  const admin = adminRole !== null;
  const profileContext = admin
    ? "ADMIN"
    : profileCapabilities.customer && profileCapabilities.craftsman
      ? "COMBINED"
      : profileCapabilities.craftsman
        ? "CRAFTSMAN"
        : "CUSTOMER";
  const locationCode = Number(slug) % 2 === 0 ? "SK:TEST_EAST" : "SK:TEST_WEST";
  const professionCode =
    Number(slug) % 2 === 0 ? "TEST:PROFESSION_B" : "TEST:PROFESSION_A";
  return freezeFixture({
    accountKind,
    accountState,
    adminRole,
    adultAttestedAt: createdAt,
    analyticsActor: {
      is_internal: admin,
      is_test: true,
      kind: "ACTOR",
      profile_context: profileContext,
      user_id: userId,
    },
    createdAt,
    emailVerifiedAt: createdAt,
    fixtureId: `synthetic-account-${slug}`,
    locationCodes: [locationCode],
    mfaFactor: admin
      ? {
          credentialReference: `test-fixture:mfa/${slug}`,
          displayLabel: `Synthetic ${adminRole} factor`,
          kind: "WEBAUTHN",
        }
      : null,
    normalizedEmail: `synthetic.account.${slug}@portal.invalid`,
    normalizedPhone: `+999000000${slug}`,
    phoneVerifiedAt: createdAt,
    professionCodes: profileCapabilities.craftsman ? [professionCode] : [],
    profileCapabilities,
    synthetic: true,
    userId,
  });
}

function freezeFixture(
  value: SyntheticAccountFixture,
): SyntheticAccountFixture {
  return Object.freeze({
    ...value,
    analyticsActor: Object.freeze(value.analyticsActor),
    locationCodes: Object.freeze(value.locationCodes),
    mfaFactor: value.mfaFactor === null ? null : Object.freeze(value.mfaFactor),
    professionCodes: Object.freeze(value.professionCodes),
    profileCapabilities: Object.freeze(value.profileCapabilities),
  });
}
