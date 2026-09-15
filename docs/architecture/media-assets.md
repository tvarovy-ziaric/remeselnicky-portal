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

R0-018 implements image signature validation and decode/re-encode below;
document validation and malware scanning belong to R0-019.
Authorization-checked downloads belong to R0-020. Until then, `PROCESSING`
files are not counterpart-visible.

Every committed `PROCESSING` asset now creates one durable PostgreSQL media
job in the same transaction as its metadata. The job contains only the opaque
asset ID and `IMAGE`/`DOCUMENT` kind. A bounded lease with `SKIP LOCKED`
claiming supports concurrent workers and crash recovery; exact-attempt
acknowledge/retry/terminal transitions prevent a stale worker from completing
a newer lease. Successful and terminal rows remain as idempotency and
operational evidence. Queue history is append-protected and contains no
filename, owner, storage key, hash, provenance or file bytes.

## Object-storage runtime adapter

The runtime adapter speaks the S3 protocol without selecting a hosting vendor.
Staging and production configuration must provide an HTTPS endpoint, region,
separate private and public-derivative containers, a public derivative origin,
and container-scoped credentials through the secret manager. Object keys remain
server-generated and purpose-prefixed; caller filenames never become keys.

Private processing reads request at most the configured byte ceiling plus one
sentinel byte and also validate provider range metadata. Streaming stops as soon
as the ceiling is exceeded. Private delivery uses a signed `GetObject` request
whose lifetime is rounded down and capped by the central 300-second storage
boundary; the media delivery service applies its stricter 60-second cap and
reauthorizes after signing. Public URLs are derived only for objects already
stored in the public-derivative container, and revocation deletes that exact
derivative. Choosing and provisioning the S3-compatible service, bucket policy,
malware scanner and environment credentials remains a D30 staging/production
gate rather than a code-level default.

## Image canonicalization (R0-018)

Image jobs carry only an opaque `MediaAsset` ID. The worker reloads the current
server-owned source row and reads the original through the bounded private
processing storage port; untrusted bytes and storage keys are never copied into
queue telemetry.

- JPEG, PNG and HEIF/HEIC require both an allowlisted declared MIME and a
  matching magic/file-type signature. The decoder-reported format is checked a
  second time. Extension and display filename do not participate in trust.
- HEVC-branded HEIC is decoded only when the deployed libvips runtime advertises
  HEIC/HEIF input support. The pinned official prebuild currently advertises
  AVIF-only libheif input, so HEVC input receives the stable
  `UNSUPPORTED_IMAGE_FORMAT` rejection rather than being mislabeled malformed
  or entering a retry loop. The capability guard is exercised in CI and allows
  a future codec-enabled build without changing domain contracts.
- `sharp`/libvips is pinned and invoked with warning-fail decode, a 15 MiB
  storage-read ceiling, 40 megapixel limit, 12,000-pixel per-dimension limit and
  a single-page limit. These are implementation tuning values, not product
  semantics.
- EXIF orientation is applied to pixels. Canonical output is metadata-free WebP
  at quality 82 and at most 2,560 px on either side; the private thumbnail is at
  most 384 px. Output never reuses arbitrary original bytes as canonical data.
- The only retained image metadata is an explicit `captured_at`. It is accepted
  only when `DateTimeOriginal` has a valid explicit UTC offset and resolves to a
  plausible timestamp. Ambiguous dates, GPS and all remaining EXIF are dropped.
- Canonical and thumbnail objects are written privately first. One locked DB
  transaction then inserts both immutable object references/hashes and changes
  `PROCESSING` to `READY`. A database constraint requires bounded canonical
  dimensions for every ready image. Generic completion cannot make an image
  ready.
- Deterministic hostile-input outcomes become stable `REJECTED` codes and the
  queue acknowledges them, preventing crash loops. Source-storage, derivative
  storage and database availability failures are retryable. Objects written by
  a partial/racing attempt are reported to the orphan reconciler and are never
  exposed as ready assets.

An orphan report is a reconciliation signal, never an instruction to blindly
delete the object: a commit response can be uncertain even when the database
transaction ultimately succeeded. Reconciliation first checks persisted opaque
references and only removes an object proven unreferenced.

Private originals remain non-canonical processing objects. Their eventual
retention/deletion is deliberately left to the D27 category-aware retention
policy; ordinary clients and counterparties receive only authorized ready
derivatives.

## Document validation and malware scanning (R0-019)

Alpha document ingestion is deliberately PDF-only. The upload admission MIME
is not trusted: the worker reloads the private original by opaque asset ID,
requires a strict PDF header/final marker, performs bounded structural checks
and uses pinned PDF.js to parse every page and operator list. Password-protected
files, embedded files, JavaScript/actions, XFA and other active document
features are rejected. The 25 MiB byte ceiling is complemented by page,
object, stream, annotation and decoded-operator ceilings so a compact but
pathologically complex PDF cannot consume unbounded worker resources.

After format validation, a provider-neutral malware scanner receives the bytes,
their SHA-256 and an abort signal. A usable `CLEAN` verdict is bound to the same
hash and carries bounded scanner engine, engine version, signature version and
scan timestamp evidence. Scanner outages and timeouts are retryable queue
failures; infected, permanently unscannable and malformed inputs become stable
business rejections and are acknowledged instead of entering a crash loop.
`BYPASS_TEST_ONLY` scanners cannot be constructed into staging or production,
and cannot mark an asset ready in local/test environments either.

Only a clean scan is copied to a new private `CANONICAL` PDF object. One locked
database transaction inserts that opaque object reference and content hash,
persists the clean scan evidence and changes `PROCESSING` to `READY`. A database
constraint and trigger independently reject a ready document without current,
hash-matching clean evidence and a non-revoked private canonical object. No
queue payload, rejection code or ordinary telemetry contains the filename,
document bytes, scanner detail text or access token.

The original and canonical objects are append-only references. Later Quote and
Change-order tickets can freeze a submitted commercial revision by referencing
the exact asset/hash; a revised PDF must create a new asset and cannot overwrite
the submitted binary or provenance.
