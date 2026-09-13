CREATE TYPE media_asset_status AS ENUM (
  'PROCESSING',
  'READY',
  'REJECTED'
);

CREATE TYPE media_kind AS ENUM (
  'IMAGE',
  'DOCUMENT'
);

CREATE TYPE media_upload_purpose AS ENUM (
  'PROFILE_IMAGE',
  'PORTFOLIO_IMAGE',
  'JOB_REQUEST_IMAGE',
  'JOB_IMAGE',
  'JOB_DOCUMENT',
  'CHAT_IMAGE',
  'CHAT_DOCUMENT',
  'CREDENTIAL_DOCUMENT',
  'QUOTE_DOCUMENT',
  'CHANGE_ORDER_DOCUMENT',
  'DISPUTE_EVIDENCE'
);

CREATE TYPE media_provenance_entity_type AS ENUM (
  'USER_PROFILE',
  'PORTFOLIO_PROJECT',
  'JOB_REQUEST',
  'JOB',
  'JOB_PARTICIPANT',
  'CONVERSATION_MESSAGE',
  'CREDENTIAL',
  'QUOTE_REVISION',
  'CHANGE_ORDER_REVISION',
  'DISPUTE_CASE'
);

CREATE TYPE media_storage_area AS ENUM (
  'private',
  'public-derivative'
);

CREATE TYPE media_storage_role AS ENUM (
  'ORIGINAL_UPLOAD',
  'CANONICAL',
  'THUMBNAIL',
  'DETAIL'
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind media_kind NOT NULL,
  purpose media_upload_purpose NOT NULL,
  status media_asset_status NOT NULL DEFAULT 'PROCESSING',
  declared_content_type text NOT NULL,
  display_filename text,
  byte_size integer NOT NULL,
  provenance_entity_type media_provenance_entity_type,
  provenance_entity_id uuid,
  provenance_entity_revision integer,
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status_changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at timestamptz,
  rejected_at timestamptz,
  CONSTRAINT media_assets_content_type_canonical
    CHECK (
      declared_content_type = lower(btrim(declared_content_type))
      AND length(declared_content_type) BETWEEN 3 AND 100
      AND declared_content_type !~ '[[:space:];]'
    ),
  CONSTRAINT media_assets_display_filename_bounded
    CHECK (
      display_filename IS NULL
      OR (
        length(display_filename) BETWEEN 1 AND 255
        AND position('/' IN display_filename) = 0
        AND position(chr(92) IN display_filename) = 0
        AND display_filename !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT media_assets_byte_size_bounded
    CHECK (byte_size BETWEEN 1 AND 26214400),
  CONSTRAINT media_assets_provenance_complete
    CHECK (
      (provenance_entity_type IS NULL AND provenance_entity_id IS NULL)
      OR
      (provenance_entity_type IS NOT NULL AND provenance_entity_id IS NOT NULL)
    ),
  CONSTRAINT media_assets_provenance_revision_valid
    CHECK (
      provenance_entity_revision IS NULL
      OR (
        provenance_entity_type IS NOT NULL
        AND provenance_entity_id IS NOT NULL
        AND provenance_entity_revision > 0
      )
    ),
  CONSTRAINT media_assets_status_fields_consistent
    CHECK (
      (status = 'PROCESSING' AND ready_at IS NULL AND rejected_at IS NULL AND rejection_code IS NULL)
      OR
      (status = 'READY' AND ready_at IS NOT NULL AND rejected_at IS NULL AND rejection_code IS NULL)
      OR
      (status = 'REJECTED' AND ready_at IS NULL AND rejected_at IS NOT NULL AND length(rejection_code) BETWEEN 1 AND 80)
    ),
  CONSTRAINT media_assets_timestamps_ordered
    CHECK (
      status_changed_at >= created_at
      AND updated_at >= status_changed_at
      AND (ready_at IS NULL OR ready_at >= created_at)
      AND (rejected_at IS NULL OR rejected_at >= created_at)
    )
);

CREATE INDEX media_assets_owner_created_idx
  ON media_assets (owner_user_id, created_at DESC);

CREATE INDEX media_assets_uploader_created_idx
  ON media_assets (uploaded_by_user_id, created_at DESC);

CREATE INDEX media_assets_processing_idx
  ON media_assets (created_at)
  WHERE status = 'PROCESSING';

CREATE INDEX media_assets_provenance_idx
  ON media_assets (provenance_entity_type, provenance_entity_id)
  WHERE provenance_entity_id IS NOT NULL;

CREATE TABLE media_asset_storage_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  role media_storage_role NOT NULL,
  storage_area media_storage_area NOT NULL,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  content_sha256 character(64),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  CONSTRAINT media_asset_storage_objects_key_unique UNIQUE (storage_key),
  CONSTRAINT media_asset_storage_objects_role_unique UNIQUE (media_asset_id, role),
  CONSTRAINT media_asset_storage_objects_key_matches_area
    CHECK (
      (storage_area = 'private' AND storage_key ~ '^private/[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR
      (storage_area = 'public-derivative' AND storage_key ~ '^public-derivative/[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    ),
  CONSTRAINT media_asset_storage_objects_content_type_canonical
    CHECK (
      content_type = lower(btrim(content_type))
      AND length(content_type) BETWEEN 3 AND 100
      AND content_type !~ '[[:space:];]'
    ),
  CONSTRAINT media_asset_storage_objects_byte_size_bounded
    CHECK (byte_size BETWEEN 1 AND 26214400),
  CONSTRAINT media_asset_storage_objects_hash_valid
    CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT media_asset_storage_objects_revocation_ordered
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX media_asset_storage_objects_asset_idx
  ON media_asset_storage_objects (media_asset_id, created_at);
