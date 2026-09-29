# Slovak municipality and postal-code reference snapshot

This directory contains the compact, deterministic application snapshot in
`snapshot.json`. It is derived exclusively from public, machine-readable
official sources. It does not contain street, house-number or personal data.

## Authority and version

- Authority: Ministry of Interior of the Slovak Republic (MV SR), Register of
  Addresses.
- Dataset: **Adresy podľa krajov (csv)**, distribution **Adresy podľa krajov
  (všetky kraje)**.
- Catalog dataset ID: `b27f57f1-7e76-45e0-8968-631f9176b2e9`.
- Distribution ID: `d22c42f3-82b5-450d-b8fb-4245d50a31ec`.
- Source file name: `Adresy pod_a krajov UTF8_04_2026.csv`.
- Snapshot/version: `2026-04` (the month encoded by the publisher in the
  distributed file name). The database effective date is normalized to
  `2026-04-01` because the publisher supplies month, not day, precision.
- Catalog last updated: 2026-08-21.
- License: CC0 1.0 for the work, original database and database rights.
- Catalog URL:
  <https://data.slovensko.sk/datasety/b27f57f1-7e76-45e0-8968-631f9176b2e9>
- Download URL:
  <https://data.slovensko.sk/download?id=d22c42f3-82b5-450d-b8fb-4245d50a31ec>
- License URL: <https://creativecommons.org/publicdomain/zero/1.0/>

The address CSV supplies postal-code associations and address-point
coordinates. Canonical codes and the administrative hierarchy come from the
official MV SR Register adries initialization exports dated 2024-05-21:

- regions: `f4a64612-878d-4e68-91b7-5f4782b150cc`;
- districts: `5b7b41e6-ea44-4a8b-ba8c-532bd80f8cb1`;
- municipalities / CL000025:
  `4ba7672f-cad5-492a-a1bb-a992038f09e5`.

The six-digit canonical municipality code is the official municipality suffix
of the CL000025 LAU identifier (for example `SK0227513881` -> `513881`,
Prievidza); it is not inferred from names or postal codes. Municipality
centroids are aggregate representative points calculated deterministically
from official address points. They are approximate matching data, never exact
customer or home addresses.

Only official statuses `MUNICIPALITY`, `CITY` and `CITY_DISTRICT` are
user-selectable. `MILITARY_DISTRICT` records are deliberately excluded and the
generator fails on any unknown future status.

Raw file SHA-256 values:

- address CSV: `312b38f506ee2f635fca0dd9c3a413d0e789506713919b5c3d78a5780a6fdbd3`;
- region ZIP: `93076d32f45ca46350ce77bc3415f49be880e64be15d0e891cc432cd7146e0ac`;
- district ZIP: `b823cc87f90df626b71172591e3059fd47afdc494869e1407c3caca6da582d53`;
- municipality ZIP: `efac7140a1024bcf76511c65684a96ffd15db432842d6cd18b5cfcc42916db14`.

The generator also pins the extracted hierarchy XML checksums:

- region XML: `c911fdb768f48dfd57528385c0607bcffdf51567a1dce9e97b9f0d813a6cebb5`;
- district XML: `0051eb42e3e72f1ce3e372c82af0f5c2342676ec92126dc9ba99dea7c735ac41`;
- municipality XML: `9af72930b0c97cc4641d8f694c01101d9eef6145c1583152a283507c265bae35`.

## Supplementary PSČ source

Slovenská pošta also publishes **Poštové smerovacie čísla na stiahnutie**,
including `OBCE.xlsx` and `ULICE.xlsx`:

- Page: <https://www.posta.sk/psc>
- ZIP: <https://www.posta.sk/files/6811e10125b182cd7cd9e3a9/postove-smerovacie-cisla-na-stiahnutie.zip>

Downloaded ZIP SHA-256:
`7f9e3686df8c3f67ca121f8581f334e9c5dd5b28cec7b97e106e3b73a356d54c`.
Slovenská pošta describes the OBCE and ULICE lists as complete for finding the
territorial PSČ of an address and says they are normally updated at least
monthly. It is recorded as a supplementary audit source, but the committed
snapshot is derived from the MV SR files above and never substitutes a postal
label for the MV SR canonical municipality code.

## Safety and update policy

`snapshot.json` is accepted only when the validator confirms all of the
following:

- its content SHA-256 matches;
- all arrays are uniquely sorted and their declared counts match;
- all region/district/municipality relationships resolve;
- canonical municipality and postal-code formats are valid;
- every coordinate remains within Slovakia's bounding box;
- all municipality/postal-code links resolve;
- canonical Prievidza (`513881`) maps to `971 01`, while `513792` remains
  correctly assigned to Malá Tŕňa.

The committed snapshot contains 8 regions, 79 districts, 2,924 selectable
municipalities/city districts, 1,415 postal codes and 3,283 many-to-many links.

The database import is explicit, transactional, advisory-lock protected and
idempotent. Conflicting rows fail closed and roll the whole import back. It
never deletes user data. Postal codes are stored independently from
municipalities and the temporal many-to-many association preserves the D07
municipality code as the business identifier.

To validate the committed snapshot:

```bash
pnpm --filter @portal/db location:validate
```

To import it after migrations have been applied:

```bash
LOCATION_REFERENCE_IMPORT=1 DATABASE_URL=... \
  pnpm --filter @portal/db location:import
```

Raw national address files are intentionally not committed. A future refresh
must use a newly versioned directory, record the new official distribution and
its SHA-256, regenerate deterministically, pass validation, and be reviewed as
reference-data provenance. Do not edit or infer individual records by hand.

The deterministic generator is `build-snapshot.mjs`. It requires the three
official hierarchy XML files and the address CSV as explicit arguments, rejects
unmatched or ambiguous municipality keys, and writes sorted output whose
content checksum is revalidated by the importer.
