import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const EXPECTED_HEADER = [
  "IDENTIFIKATOR",
  "KRAJ",
  "OKRES",
  "OBEC",
  "CAST_OBCE",
  "ULICA",
  "SUPISNE_CISLO",
  "ORIENTACNE_CISLO_CELE",
  "PSC",
  "ADRBOD_X",
  "ADRBOD_Y",
];
const EXPECTED_SHA256 = {
  addresses: "312b38f506ee2f635fca0dd9c3a413d0e789506713919b5c3d78a5780a6fdbd3",
  districts: "0051eb42e3e72f1ce3e372c82af0f5c2342676ec92126dc9ba99dea7c735ac41",
  municipalities:
    "9af72930b0c97cc4641d8f694c01101d9eef6145c1583152a283507c265bae35",
  regions: "c911fdb768f48dfd57528385c0607bcffdf51567a1dce9e97b9f0d813a6cebb5",
};

const args = parseArgs(process.argv.slice(2));
for (const name of [
  "regions",
  "districts",
  "municipalities",
  "addresses",
  "output",
]) {
  if (!args[name]) {
    throw new Error(`Missing required --${name} argument.`);
  }
}

const [regionsXml, districtsXml, municipalitiesXml, inputHashes] =
  await Promise.all([
    readFile(args.regions, "utf8"),
    readFile(args.districts, "utf8"),
    readFile(args.municipalities, "utf8"),
    Promise.all(
      Object.keys(EXPECTED_SHA256).map(async (name) => [
        name,
        await sha256File(args[name]),
      ]),
    ),
  ]);
for (const [name, hash] of inputHashes) {
  if (hash !== EXPECTED_SHA256[name]) {
    throw new Error(`Official ${name} input checksum mismatch.`);
  }
}
const rawAddressSha256 = EXPECTED_SHA256.addresses;

const regionRecords = parseCurrentChanges(regionsXml, "regionChange");
const districtRecords = parseCurrentChanges(districtsXml, "countyChange");
const municipalityRecords = parseCurrentChanges(
  municipalitiesXml,
  "municipalityChange",
);

const regionByObjectId = new Map();
const regions = regionRecords.map((record) => {
  const code = tag(record, "ItemCode");
  const name = tag(record, "ItemName");
  if (!/^SK[A-Z0-9]{3}$/u.test(code)) {
    throw new Error(`Invalid current region code ${code}.`);
  }
  regionByObjectId.set(tag(record, "objectId"), code);
  return { code, name };
});

const districtByObjectId = new Map();
const districts = districtRecords.map((record) => {
  const code = tag(record, "ItemCode");
  const name = tag(record, "ItemName");
  const regionCode = regionByObjectId.get(tag(record, "regionIdentifier"));
  if (!/^SK[A-Z0-9]{4}$/u.test(code) || !regionCode) {
    throw new Error(`Invalid current district ${code}/${name}.`);
  }
  districtByObjectId.set(tag(record, "objectId"), { code, name, regionCode });
  return { code, regionCode, name };
});

const allMunicipalityCatalog = municipalityRecords.map((record) => {
  const status = tag(record, "status");
  if (
    !["MUNICIPALITY", "CITY", "CITY_DISTRICT", "MILITARY_DISTRICT"].includes(
      status,
    )
  ) {
    throw new Error(`Unsupported current municipality status ${status}.`);
  }
  const lauCode = tag(record, "ItemCode");
  const code = lauCode.slice(-6);
  const name = tag(record, "ItemName");
  const district = districtByObjectId.get(tag(record, "countyIdentifier"));
  if (
    !/^SK[A-Z0-9]{10}$/u.test(lauCode) ||
    !/^\d{6}$/u.test(code) ||
    !district
  ) {
    throw new Error(`Invalid current municipality ${lauCode}/${name}.`);
  }
  return {
    code,
    districtCode: district.code,
    districtName: district.name,
    name,
    status,
  };
});
const municipalityCatalog = allMunicipalityCatalog.filter(
  ({ status }) => status !== "MILITARY_DISTRICT",
);
const excludedMilitaryJoinKeys = new Set(
  allMunicipalityCatalog
    .filter(({ status }) => status === "MILITARY_DISTRICT")
    .map(({ name, districtName }) => joinKey(name, districtName)),
);

const municipalityByJoinKey = new Map();
for (const municipality of municipalityCatalog) {
  const key = joinKey(municipality.name, municipality.districtName);
  if (municipalityByJoinKey.has(key)) {
    throw new Error(`Ambiguous official municipality join key ${key}.`);
  }
  municipalityByJoinKey.set(key, municipality);
}

const aggregates = new Map();
const unmatched = new Map();
let rowCount = 0;
let headerSeen = false;
const lines = createInterface({
  input: createReadStream(args.addresses, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
for await (const line of lines) {
  if (!headerSeen) {
    const header = parseDelimitedRow(line.replace(/^\uFEFF/u, ""));
    if (JSON.stringify(header) !== JSON.stringify(EXPECTED_HEADER)) {
      throw new Error(`Unexpected address CSV header: ${header.join("|")}`);
    }
    headerSeen = true;
    continue;
  }
  if (line.length === 0) continue;
  rowCount += 1;
  const fields = parseDelimitedRow(line);
  if (fields.length !== EXPECTED_HEADER.length) {
    throw new Error(`Malformed address CSV row ${rowCount + 1}.`);
  }
  const [
    ,
    ,
    districtName,
    municipalityName,
    ,
    ,
    ,
    ,
    rawPostal,
    rawLon,
    rawLat,
  ] = fields;
  const key = joinKey(municipalityName, districtName);
  const municipality = municipalityByJoinKey.get(key);
  if (!municipality) {
    if (excludedMilitaryJoinKeys.has(key)) continue;
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    continue;
  }
  const postalCode = rawPostal.replace(/\s/gu, "");
  const longitude = Number(rawLon.replace(",", "."));
  const latitude = Number(rawLat.replace(",", "."));
  if (postalCode !== "" && !/^\d{5}$/u.test(postalCode)) {
    throw new Error(
      `Invalid postal code or coordinate at address row ${rowCount + 1}.`,
    );
  }
  const aggregate = aggregates.get(municipality.code) ?? {
    count: 0,
    latitudeSum: 0,
    longitudeSum: 0,
    postalCodes: new Set(),
  };
  if (postalCode !== "") aggregate.postalCodes.add(postalCode);
  if (rawLon === "" && rawLat === "") {
    aggregates.set(municipality.code, aggregate);
    continue;
  }
  if (
    rawLon === "" ||
    rawLat === "" ||
    !Number.isFinite(longitude) ||
    longitude < 16 ||
    longitude > 23 ||
    !Number.isFinite(latitude) ||
    latitude < 47 ||
    latitude > 50
  ) {
    throw new Error(
      `Invalid postal code or coordinate at address row ${rowCount + 1}.`,
    );
  }
  aggregate.count += 1;
  aggregate.latitudeSum += latitude;
  aggregate.longitudeSum += longitude;
  aggregates.set(municipality.code, aggregate);
}

if (!headerSeen || rowCount === 0) {
  throw new Error("Address CSV is empty.");
}
if (unmatched.size > 0) {
  const examples = [...unmatched.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "sk"))
    .slice(0, 20)
    .map(([key, count]) => `${key} (${count})`)
    .join(", ");
  throw new Error(
    `${unmatched.size} address municipality keys did not resolve: ${examples}`,
  );
}

const missingMunicipalities = municipalityCatalog.filter(
  ({ code }) => !aggregates.has(code) || aggregates.get(code).count === 0,
);
if (missingMunicipalities.length > 0) {
  throw new Error(
    `${missingMunicipalities.length} current municipalities have no address rows: ` +
      missingMunicipalities
        .slice(0, 20)
        .map(({ code, name }) => `${code}/${name}`)
        .join(", "),
  );
}

const municipalities = municipalityCatalog.map(
  ({ code, districtCode, name }) => {
    const aggregate = aggregates.get(code);
    return {
      code,
      districtCode,
      name,
      latitude: roundCoordinate(aggregate.latitudeSum / aggregate.count),
      longitude: roundCoordinate(aggregate.longitudeSum / aggregate.count),
    };
  },
);

const municipalityPostalCodes = municipalityCatalog.flatMap(({ code }) =>
  [...aggregates.get(code).postalCodes].map((postalCode) => ({
    municipalityCode: code,
    postalCode,
    isPrimary: false,
  })),
);
const postalCodes = [
  ...new Set(municipalityPostalCodes.map(({ postalCode }) => postalCode)),
];

regions.sort(byCode);
districts.sort(byCode);
municipalities.sort(byCode);
postalCodes.sort();
municipalityPostalCodes.sort((left, right) =>
  `${left.municipalityCode}\0${left.postalCode}`.localeCompare(
    `${right.municipalityCode}\0${right.postalCode}`,
  ),
);

const snapshotWithoutHash = {
  schemaVersion: 1,
  source: {
    authority: "Ministerstvo vnútra Slovenskej republiky",
    catalogUrl:
      "https://data.slovensko.sk/datasety/b27f57f1-7e76-45e0-8968-631f9176b2e9",
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    rawSha256: rawAddressSha256,
    revision: "mv-ra-addresses-2026-04+cl-2024-05-21",
    // The publisher supplies month precision only; normalize it to month start.
    snapshotDate: "2026-04-01",
  },
  counts: {
    regions: regions.length,
    districts: districts.length,
    municipalities: municipalities.length,
    postalCodes: postalCodes.length,
    municipalityPostalCodes: municipalityPostalCodes.length,
  },
  regions,
  districts,
  municipalities,
  postalCodes,
  municipalityPostalCodes,
};
const canonicalContent = {
  counts: snapshotWithoutHash.counts,
  districts: snapshotWithoutHash.districts,
  municipalities: snapshotWithoutHash.municipalities,
  municipalityPostalCodes: snapshotWithoutHash.municipalityPostalCodes,
  postalCodes: snapshotWithoutHash.postalCodes,
  regions: snapshotWithoutHash.regions,
  schemaVersion: snapshotWithoutHash.schemaVersion,
  source: snapshotWithoutHash.source,
};
const contentSha256 = sha256(JSON.stringify(canonicalContent));
await writeFile(
  args.output,
  `${JSON.stringify({ ...snapshotWithoutHash, contentSha256 }, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `${JSON.stringify({ ...snapshotWithoutHash.counts, addressRows: rowCount, rawAddressSha256, contentSha256 })}\n`,
);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function parseCurrentChanges(xml, elementName) {
  const records = [];
  const matcher = new RegExp(
    `<${elementName}>[\\s\\S]*?<\\/${elementName}>`,
    "gu",
  );
  for (const match of xml.matchAll(matcher)) {
    if (tag(match[0], "validTo").startsWith("3000-")) records.push(match[0]);
  }
  if (records.length === 0)
    throw new Error(`No current ${elementName} records.`);
  return records;
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "u"));
  if (!match) throw new Error(`Missing ${name} in official XML record.`);
  return decodeXml(match[1].trim());
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function normalizeName(value) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("sk-SK")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function joinKey(municipalityName, districtName) {
  return `${normalizeName(municipalityName)}\0${normalizeName(districtName)}`;
}

function parseDelimitedRow(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ";" && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Unclosed quote in address CSV.");
  fields.push(field);
  return fields;
}

function roundCoordinate(value) {
  return Number(value.toFixed(7));
}

function byCode(left, right) {
  return left.code.localeCompare(right.code);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
