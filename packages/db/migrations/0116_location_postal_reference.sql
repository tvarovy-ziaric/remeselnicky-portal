CREATE TABLE location_reference_imports (
  source_revision text PRIMARY KEY,
  snapshot_sha256 char(64) NOT NULL UNIQUE,
  effective_on date NOT NULL,
  source_reference text NOT NULL,
  license_reference text NOT NULL,
  region_count integer NOT NULL,
  district_count integer NOT NULL,
  municipality_count integer NOT NULL,
  postal_code_count integer NOT NULL,
  municipality_postal_code_count integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT location_reference_imports_revision_safe CHECK (
    source_revision = btrim(source_revision)
    AND length(source_revision) BETWEEN 1 AND 120
  ),
  CONSTRAINT location_reference_imports_sha256 CHECK (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT location_reference_imports_references_safe CHECK (
    source_reference = btrim(source_reference)
    AND length(source_reference) BETWEEN 1 AND 500
    AND license_reference = btrim(license_reference)
    AND length(license_reference) BETWEEN 1 AND 500
  ),
  CONSTRAINT location_reference_imports_counts_positive CHECK (
    region_count > 0
    AND district_count > 0
    AND municipality_count > 0
    AND postal_code_count > 0
    AND municipality_postal_code_count > 0
  )
);

CREATE TABLE location_postal_codes (
  code text PRIMARY KEY,
  is_active boolean NOT NULL DEFAULT true,
  source_reference text NOT NULL,
  source_revision text NOT NULL
    REFERENCES location_reference_imports(source_revision) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT location_postal_codes_canonical CHECK (code ~ '^[0-9]{5}$'),
  CONSTRAINT location_postal_codes_source_safe CHECK (
    source_reference = btrim(source_reference)
    AND length(source_reference) BETWEEN 1 AND 500
  ),
  CONSTRAINT location_postal_codes_timestamps_ordered CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX location_postal_codes_prefix_idx
  ON location_postal_codes (code text_pattern_ops)
  WHERE is_active;

CREATE TABLE location_municipality_postal_codes (
  municipality_code text NOT NULL
    REFERENCES location_municipalities(code) ON DELETE RESTRICT,
  postal_code text NOT NULL
    REFERENCES location_postal_codes(code) ON DELETE RESTRICT,
  valid_from date NOT NULL,
  valid_to date,
  is_active boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT false,
  source_reference text NOT NULL,
  source_revision text NOT NULL
    REFERENCES location_reference_imports(source_revision) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (municipality_code, postal_code, valid_from),
  CONSTRAINT location_municipality_postal_codes_validity_ordered CHECK (
    valid_to IS NULL OR valid_to >= valid_from
  ),
  CONSTRAINT location_municipality_postal_codes_source_safe CHECK (
    source_reference = btrim(source_reference)
    AND length(source_reference) BETWEEN 1 AND 500
  ),
  CONSTRAINT location_municipality_postal_codes_timestamps_ordered CHECK (
    updated_at >= created_at
  )
);

CREATE UNIQUE INDEX location_municipality_postal_codes_current_pair_key
  ON location_municipality_postal_codes (municipality_code, postal_code)
  WHERE is_active;
CREATE INDEX location_municipality_postal_codes_postal_lookup_idx
  ON location_municipality_postal_codes (
    postal_code text_pattern_ops, municipality_code
  )
  WHERE is_active;
CREATE INDEX location_municipality_postal_codes_municipality_lookup_idx
  ON location_municipality_postal_codes (
    municipality_code, is_primary DESC, postal_code
  )
  WHERE is_active;

COMMENT ON TABLE location_reference_imports IS
  'Immutable provenance ledger for validated Slovak location reference snapshots.';
COMMENT ON TABLE location_postal_codes IS
  'Canonical five-digit Slovak postal codes; never a municipality identifier.';
COMMENT ON TABLE location_municipality_postal_codes IS
  'Time-aware many-to-many municipality/postal-code reference mapping. Multiple postal codes per municipality and multiple municipalities per postal code are intentional.';
