# Media asset ingestion boundary

R0-017 introduces one server-owned `MediaAsset` abstraction for profile,
portfolio, request, chat, credential and commercial-document uploads.

- A current authenticated and `ACTIVE` actor is required before bytes are
  accepted. The initial owner and uploader are derived from that trusted actor;
  neither ID comes from the client payload.
- Upload purpose selects a central MIME allowlist and byte-size ceiling. These
  are admission checks only. The object remains `PROCESSING` until the image or
  document pipeline validates its real signature and content.
- Raw uploads always enter private object storage under a server-generated key.
  Client filenames are reduced to bounded basename-only display metadata and
  are never passed to object storage.
- Metadata and the initial private storage reference are inserted in one DB
  transaction. If object storage succeeds but metadata persistence fails, the
  required orphan observer receives the opaque private reference for cleanup or
  reconciliation; no public delivery path is invoked.
- Processing completion is a guarded one-way database transition from
  `PROCESSING` to exactly one of `READY` or `REJECTED`. A repeated or racing
  transition returns `NOT_PROCESSING` and cannot rewrite the first outcome.
- Provenance accepts only a server-created marker and stores an optional typed
  entity UUID/revision hook. Later domain tickets resolve and bind concrete
  Portfolio, Job, Message and immutable commercial-revision relationships.

Signature/magic-byte validation, image decode/re-encode and document malware
scanning belong to R0-018/R0-019. Authorization-checked downloads belong to
R0-020. Until then, `PROCESSING` files are not counterpart-visible.
