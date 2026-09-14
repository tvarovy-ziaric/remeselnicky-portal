ALTER TABLE media_assets
  ADD COLUMN captured_at timestamptz,
  ADD COLUMN canonical_width integer,
  ADD COLUMN canonical_height integer;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_image_dimensions_consistent
    CHECK (
      (
        kind = 'IMAGE'
        AND status = 'READY'
        AND canonical_width BETWEEN 1 AND 2560
        AND canonical_height BETWEEN 1 AND 2560
      )
      OR
      (
        (kind <> 'IMAGE' OR status <> 'READY')
        AND canonical_width IS NULL
        AND canonical_height IS NULL
      )
    ),
  ADD CONSTRAINT media_assets_captured_at_consistent
    CHECK (
      captured_at IS NULL
      OR (
        kind = 'IMAGE'
        AND status = 'READY'
        AND captured_at >= timestamptz '2000-01-01 00:00:00+00'
      )
    );

ALTER TABLE media_asset_storage_objects
  ADD CONSTRAINT media_asset_storage_objects_private_source_and_canonical
    CHECK (
      role NOT IN ('ORIGINAL_UPLOAD', 'CANONICAL')
      OR storage_area = 'private'
    );
