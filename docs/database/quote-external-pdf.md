# EXTERNAL_PDF Quote authoring

R3-017 implements the D14-B external-PDF path without duplicating PDF line
items in the platform or assigning legal precedence beyond locked D16.

## Commercial envelope and PDF history

Each content revision contains only the provider-confirmed comparison envelope:
price mode, EUR total or range, VAT status, and optional start, duration,
validity, deposit, and material responsibility. The exact save command records
the provider's true-only confirmation that this summary matches the selected
PDF; the effect derives immutable `confirmed_at`, `saved_at`, and content
revision values from that server command.

An external Quote DRAFT may replace a mistaken PDF. Each replacement is a new
READY `MediaAsset` and a new append-only content revision; the prior binding and
content remain historical. CAS permits only one concurrent replacement to
become current. A media asset is globally bindable only once and must carry
exact `QUOTE_REVISION` provenance. After SUBMIT, edits are read-only and a
correction uses a new core Quote revision with another asset.

Bound assets cannot be deleted because commercial bindings use restrictive
foreign keys. Unbound PROCESSING/REJECTED attempts remain ordinary private media
subject to the existing media-retention/orphan cleanup policy; 0050 does not
make failed upload attempts permanent commercial records.

## Upload and submission gates

The upload preparation seam locks and revalidates the ACTIVE primary provider,
ENGAGED/WRITABLE invitation/conversation, exact Quote, EXTERNAL_PDF revision,
and DRAFT head before issuing trusted media provenance. The common document
pipeline owns PDF magic/type/size validation, malware scanning, private
canonical storage, and READY state. The database additionally rejects raw
`QUOTE_DOCUMENT` media inserts without an exact owned writable DRAFT Quote
revision; this generic provenance guard does not require the external authoring
mode so D14-A supporting Quote PDFs remain possible through their future
feature-specific authorizer.
For `QUOTE_DOCUMENT` assets, owner/uploader, purpose/kind, declared file
identity, display name, byte size, provenance, and creation time are immutable;
only the processor-owned status/evidence/timestamp transition remains mutable.

Submission keeps the PLATFORM_STRUCTURED eligibility branch unchanged. The
EXTERNAL_PDF branch locks the current exact content binding, media asset, and
private canonical object after the Quote-core lock. It requires READY DOCUMENT,
QUOTE_DOCUMENT purpose, exact quote/revision provenance, matching canonical
hash, a live private `application/pdf` canonical, provider confirmation, and
non-expired validity. SAVE and SUBMIT therefore serialize on the same lock
order. Canonical revocation also serializes on the selected object: a revocation
that wins first blocks submission; submission that wins first preserves its
immutable history, while subsequent delivery fails closed.

## Reads and private delivery

The outward revision DTO allowlists only the concise envelope, server dates,
`pdfAssetId`, and relative `/v1/media/{assetId}/download` path. It never exposes
storage keys, hashes, scan evidence, filenames, or signed URLs. An ACTIVE
provider sees their own draft/history; the request customer sees only revisions
that have been submitted at least once, including later historical states.
Competitors receive no object or delivery access.

The Quote media resolver throws for unbound or spoofed assets and grants trusted
access only after reloading the exact binding, lineage, participant, actor, and
revision state. A provider may retrieve their own immutable replacement
history, while a customer may retrieve only the PDF selected by the current
content revision when that Quote revision left DRAFT. The generic private-media
service still reloads after signing, uses short-lived non-public URLs, and
returns 404 after revocation.

The standalone live assertions are in
`packages/db/test/quote-external-pdf-integration-helper.ts`; root owns migration
runner wiring.
