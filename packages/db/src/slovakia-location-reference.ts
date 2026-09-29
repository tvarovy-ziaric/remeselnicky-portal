import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface SlovakiaLocationReferenceSnapshot {
  readonly schemaVersion: 1;
  readonly source: {
    readonly authority: "Ministerstvo vnútra Slovenskej republiky";
    readonly catalogUrl: string;
    readonly license: "CC0-1.0";
    readonly licenseUrl: string;
    readonly rawSha256: string;
    readonly revision: string;
    readonly snapshotDate: string;
  };
  readonly contentSha256: string;
  readonly counts: {
    readonly regions: number;
    readonly districts: number;
    readonly municipalities: number;
    readonly postalCodes: number;
    readonly municipalityPostalCodes: number;
  };
  readonly regions: readonly {
    readonly code: string;
    readonly name: string;
  }[];
  readonly districts: readonly {
    readonly code: string;
    readonly regionCode: string;
    readonly name: string;
  }[];
  readonly municipalities: readonly {
    readonly code: string;
    readonly districtCode: string;
    readonly name: string;
    readonly latitude: number;
    readonly longitude: number;
  }[];
  readonly postalCodes: readonly string[];
  readonly municipalityPostalCodes: readonly {
    readonly municipalityCode: string;
    readonly postalCode: string;
    readonly isPrimary: boolean;
  }[];
}

const SAFE_CODE = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/u;
const REGION_CODE = /^SK[A-Z0-9]{3}$/u;
const DISTRICT_CODE = /^SK[A-Z0-9]{4}$/u;
const MUNICIPALITY_CODE = /^[0-9]{6}$/u;
const POSTAL_CODE = /^[0-9]{5}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export async function loadSlovakiaLocationReferenceSnapshot(
  path: string,
): Promise<SlovakiaLocationReferenceSnapshot> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Location reference snapshot is not valid JSON.");
  }
  return validateSlovakiaLocationReferenceSnapshot(parsed);
}

export function validateSlovakiaLocationReferenceSnapshot(
  value: unknown,
): SlovakiaLocationReferenceSnapshot {
  if (!isRecord(value) || value["schemaVersion"] !== 1) {
    throw new Error("Unsupported location reference snapshot schema.");
  }
  if (
    !isRecord(value["counts"]) ||
    !Array.isArray(value["regions"]) ||
    !Array.isArray(value["districts"]) ||
    !Array.isArray(value["municipalities"]) ||
    !Array.isArray(value["postalCodes"]) ||
    !Array.isArray(value["municipalityPostalCodes"])
  ) {
    throw new Error("Location reference snapshot collections are missing.");
  }
  const snapshot = value as unknown as SlovakiaLocationReferenceSnapshot;
  validateSource(snapshot.source);
  if (!SHA256.test(snapshot.contentSha256)) {
    throw new Error("Location reference snapshot checksum is malformed.");
  }

  assertCount("regions", snapshot.regions, snapshot.counts.regions, 8);
  assertCount("districts", snapshot.districts, snapshot.counts.districts, 70);
  assertCount(
    "municipalities",
    snapshot.municipalities,
    snapshot.counts.municipalities,
    2_800,
  );
  assertCount(
    "postalCodes",
    snapshot.postalCodes,
    snapshot.counts.postalCodes,
    500,
  );
  assertCount(
    "municipalityPostalCodes",
    snapshot.municipalityPostalCodes,
    snapshot.counts.municipalityPostalCodes,
    2_800,
  );

  const regionCodes = new Set<string>();
  let previous = "";
  for (const region of snapshot.regions) {
    if (
      !isNamedCode(region) ||
      !REGION_CODE.test(region.code) ||
      region.code <= previous
    ) {
      throw new Error("Regions must be unique and sorted by canonical code.");
    }
    previous = region.code;
    regionCodes.add(region.code);
  }

  const districtCodes = new Set<string>();
  previous = "";
  for (const district of snapshot.districts) {
    if (
      !isNamedCode(district) ||
      !DISTRICT_CODE.test(district.code) ||
      typeof district.regionCode !== "string" ||
      !regionCodes.has(district.regionCode) ||
      district.code <= previous
    ) {
      throw new Error("District hierarchy is invalid or non-deterministic.");
    }
    previous = district.code;
    districtCodes.add(district.code);
  }

  const municipalityCodes = new Set<string>();
  previous = "";
  for (const municipality of snapshot.municipalities) {
    if (
      !isNamedCode(municipality) ||
      !MUNICIPALITY_CODE.test(municipality.code) ||
      typeof municipality.districtCode !== "string" ||
      !districtCodes.has(municipality.districtCode) ||
      typeof municipality.latitude !== "number" ||
      municipality.latitude < 47 ||
      municipality.latitude > 50 ||
      typeof municipality.longitude !== "number" ||
      municipality.longitude < 16 ||
      municipality.longitude > 23 ||
      municipality.code <= previous
    ) {
      throw new Error("Municipality hierarchy or centroid is invalid.");
    }
    previous = municipality.code;
    municipalityCodes.add(municipality.code);
  }

  const postalCodes = new Set<string>();
  previous = "";
  for (const postalCode of snapshot.postalCodes) {
    if (
      typeof postalCode !== "string" ||
      !POSTAL_CODE.test(postalCode) ||
      postalCode <= previous
    ) {
      throw new Error("Postal codes must be canonical, unique and sorted.");
    }
    previous = postalCode;
    postalCodes.add(postalCode);
  }

  const municipalityPostalPairs = new Set<string>();
  previous = "";
  for (const link of snapshot.municipalityPostalCodes) {
    if (
      !isRecord(link) ||
      typeof link["municipalityCode"] !== "string" ||
      !municipalityCodes.has(link["municipalityCode"]) ||
      typeof link["postalCode"] !== "string" ||
      !postalCodes.has(link["postalCode"]) ||
      typeof link["isPrimary"] !== "boolean"
    ) {
      throw new Error("Municipality/postal-code reference is invalid.");
    }
    const pair = `${link["municipalityCode"]}\u0000${link["postalCode"]}`;
    if (pair <= previous || municipalityPostalPairs.has(pair)) {
      throw new Error(
        "Municipality/postal-code references must be unique and sorted.",
      );
    }
    previous = pair;
    municipalityPostalPairs.add(pair);
  }

  if (
    !snapshot.municipalities.some(
      ({ code, name }) => code === "513881" && name === "Prievidza",
    ) ||
    !snapshot.municipalityPostalCodes.some(
      ({ municipalityCode, postalCode }) =>
        municipalityCode === "513881" && postalCode === "97101",
    ) ||
    !snapshot.municipalities.some(
      ({ code, name }) => code === "513792" && name === "Malá Tŕňa",
    )
  ) {
    throw new Error("Required canonical municipality references are absent.");
  }

  const contentHash = hashSnapshotContent(snapshot);
  if (contentHash !== snapshot.contentSha256) {
    throw new Error("Location reference snapshot checksum mismatch.");
  }
  return Object.freeze(snapshot);
}

export function hashSnapshotContent(
  snapshot: Omit<SlovakiaLocationReferenceSnapshot, "contentSha256">,
): string {
  const content = {
    counts: snapshot.counts,
    districts: snapshot.districts,
    municipalities: snapshot.municipalities,
    municipalityPostalCodes: snapshot.municipalityPostalCodes,
    postalCodes: snapshot.postalCodes,
    regions: snapshot.regions,
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
  };
  return createHash("sha256")
    .update(JSON.stringify(content), "utf8")
    .digest("hex");
}

function validateSource(
  source: SlovakiaLocationReferenceSnapshot["source"],
): void {
  if (
    !isRecord(source) ||
    source["authority"] !== "Ministerstvo vnútra Slovenskej republiky" ||
    source["license"] !== "CC0-1.0" ||
    typeof source["catalogUrl"] !== "string" ||
    !source["catalogUrl"].startsWith("https://data.slovensko.sk/") ||
    typeof source["licenseUrl"] !== "string" ||
    !source["licenseUrl"].startsWith("https://creativecommons.org/") ||
    typeof source["rawSha256"] !== "string" ||
    !SHA256.test(source["rawSha256"]) ||
    typeof source["revision"] !== "string" ||
    source["revision"].length === 0 ||
    typeof source["snapshotDate"] !== "string" ||
    !DATE.test(source["snapshotDate"])
  ) {
    throw new Error("Location reference source metadata is invalid.");
  }
}

function assertCount(
  name: string,
  values: readonly unknown[],
  declared: unknown,
  minimum: number,
): void {
  if (
    typeof declared !== "number" ||
    !Number.isSafeInteger(declared) ||
    declared !== values.length ||
    declared < minimum
  ) {
    throw new Error(`Location reference ${name} count is unsafe.`);
  }
}

function isNamedCode(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["code"] === "string" &&
    SAFE_CODE.test(value["code"]) &&
    typeof value["name"] === "string" &&
    value["name"] === value["name"].trim() &&
    value["name"].length > 0 &&
    value["name"].length <= 160
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
