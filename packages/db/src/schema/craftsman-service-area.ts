import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { craftsmanProfiles } from "./craftsman-profile.js";
import { users } from "./user.js";

const geographyPoint = customType<{ data: string }>({
  dataType() {
    return "geography(Point, 4326)";
  },
});

export const CRAFTSMAN_SERVICE_AREA_COMMAND_RESULTS = [
  "APPLIED",
  "UNCHANGED",
] as const;
export const craftsmanServiceAreaCommandResultEnum = pgEnum(
  "craftsman_service_area_command_result",
  CRAFTSMAN_SERVICE_AREA_COMMAND_RESULTS,
);

function catalogColumns() {
  return {
    code: text("code").primaryKey(),
    nameSk: text("name_sk").notNull(),
    sourceReference: text("source_reference").notNull(),
    sourceRevision: text("source_revision").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  };
}

export const locationRegions = pgTable("location_regions", catalogColumns());

export const locationDistricts = pgTable(
  "location_districts",
  {
    ...catalogColumns(),
    regionCode: text("region_code")
      .notNull()
      .references(() => locationRegions.code, { onDelete: "restrict" }),
  },
  (table) => [
    index("location_districts_region_code_idx").on(
      table.regionCode,
      table.code,
    ),
  ],
);

export const locationMunicipalities = pgTable(
  "location_municipalities",
  {
    ...catalogColumns(),
    districtCode: text("district_code")
      .notNull()
      .references(() => locationDistricts.code, { onDelete: "restrict" }),
    centroid: geographyPoint("centroid").notNull(),
  },
  (table) => [
    index("location_municipalities_district_code_idx").on(
      table.districtCode,
      table.code,
    ),
    index("location_municipalities_centroid_gix").using("gist", table.centroid),
  ],
);

export const craftsmanServiceAreaCommands = pgTable(
  "craftsman_service_area_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expectedRevision: integer("expected_revision").notNull(),
    resultKind: craftsmanServiceAreaCommandResultEnum("result_kind").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    baseMunicipalityCode: text("base_municipality_code").references(
      () => locationMunicipalities.code,
      { onDelete: "restrict" },
    ),
    normalRadiusMeters: integer("normal_radius_meters"),
    maximumRadiusMeters: integer("maximum_radius_meters"),
    extraMunicipalityCodes: jsonb("extra_municipality_codes")
      .$type<readonly string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    travelFeePolicy: text("travel_fee_policy"),
    travelFeeThresholdMeters: integer("travel_fee_threshold_meters"),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("craftsman_service_area_commands_profile_created_idx").on(
      table.craftsmanProfileId,
      table.createdAt,
    ),
    check(
      "craftsman_service_area_commands_expected_revision_nonnegative",
      sql`${table.expectedRevision} >= 0`,
    ),
    check(
      "craftsman_service_area_commands_resulting_revision_positive",
      sql`${table.resultingRevision} > 0`,
    ),
  ],
);

export const craftsmanServiceAreaRevisions = pgTable(
  "craftsman_service_area_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    commandId: uuid("command_id")
      .notNull()
      .unique()
      .references(() => craftsmanServiceAreaCommands.commandId, {
        onDelete: "restrict",
      }),
    revision: integer("revision").notNull(),
    baseMunicipalityCode: text("base_municipality_code").references(
      () => locationMunicipalities.code,
      { onDelete: "restrict" },
    ),
    normalRadiusMeters: integer("normal_radius_meters"),
    maximumRadiusMeters: integer("maximum_radius_meters"),
    travelFeePolicy: text("travel_fee_policy"),
    travelFeeThresholdMeters: integer("travel_fee_threshold_meters"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("craftsman_service_area_revisions_profile_revision_key").on(
      table.craftsmanProfileId,
      table.revision,
    ),
    check(
      "craftsman_service_area_revisions_revision_positive",
      sql`${table.revision} > 0`,
    ),
  ],
);

export const craftsmanServiceAreaExtraMunicipalities = pgTable(
  "craftsman_service_area_extra_municipalities",
  {
    serviceAreaRevisionId: uuid("service_area_revision_id")
      .notNull()
      .references(() => craftsmanServiceAreaRevisions.id, {
        onDelete: "restrict",
      }),
    municipalityCode: text("municipality_code")
      .notNull()
      .references(() => locationMunicipalities.code, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.serviceAreaRevisionId, table.municipalityCode],
    }),
    unique("craftsman_service_area_extras_revision_ordinal_key").on(
      table.serviceAreaRevisionId,
      table.ordinal,
    ),
    check(
      "craftsman_service_area_extras_ordinal_positive",
      sql`${table.ordinal} > 0`,
    ),
  ],
);

export type LocationRegionRecord = typeof locationRegions.$inferSelect;
export type LocationDistrictRecord = typeof locationDistricts.$inferSelect;
export type LocationMunicipalityRecord =
  typeof locationMunicipalities.$inferSelect;
export type CraftsmanServiceAreaCommandRecord =
  typeof craftsmanServiceAreaCommands.$inferSelect;
export type CraftsmanServiceAreaRevisionRecord =
  typeof craftsmanServiceAreaRevisions.$inferSelect;
