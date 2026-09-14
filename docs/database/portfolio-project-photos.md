# Private portfolio photo attachments

R1-014 adds photos to the private `PortfolioProject` aggregate without making
the project or its media public. Alpha accepts images only and allows at most
15 currently active photos. Each attachment has an optional presentation phase
(`BEFORE`, `PROGRESS`, `AFTER`, or `OTHER`) and a one-based private display
order.

## Upload and attachment boundary

`preparePortfolioPhotoUpload` is the server-only boundary that creates trusted
`PORTFOLIO_PROJECT` media provenance. It requires the exact current project
revision, an ACTIVE profile owner, and an owned non-archived project. A request
body cannot mint `ServerMediaProvenance` by casting client IDs.

Attachment later requires that same owner's `READY` canonical `IMAGE` with
purpose `PORTFOLIO_IMAGE`, an existing historical revision of the exact project,
and a current non-revoked private WebP canonical object. Asset and canonical
object rows are locked while the attachment is accepted. A media asset has one
globally unique attachment because its immutable provenance names one
authoritative project; it cannot be reused in another project or attached twice.

No customer consent, verified Job claim, public derivative, public grant or
private-to-public promotion is created here. Those checks belong to the later
publication and customer-property-consent path.

## Lifecycle, history and concurrency

The photo collection has its own compare-and-swap revision. `ATTACH`, `REORDER`,
`SET_PHASE`, `HIDE`, and `RESTORE` commands create complete immutable ordered
snapshots. Hidden attachments remain in every later snapshot with their media
identity and phase but no active display order. Restore appends the photo to the
active order and rechecks the 15-photo limit under the locked collection row.

Commands, attachment identities, revisions, and revision items are append-only.
Revision items can be inserted only in the database transaction that created
their parent revision; this prevents a later SQL insert from rewriting a sealed
historical snapshot. Deferred constraints compare every command with its prior
and resulting snapshots, including membership, order, lifecycle, phase, and
canonical image metadata. Idempotent replay returns the exact historical
resulting snapshot and rechecks the ACTIVE owner first.

## Private delivery

The ordered owner read contains only attachment/media IDs, lifecycle, phase,
order, capture time, canonical dimensions and timestamps. It excludes storage
keys, hashes, original filenames, customer identity and public state.

Private canonical download continues through the existing double-authorized,
short-lived delivery flow. `PORTFOLIO_IMAGE` additionally requires a current
`PORTFOLIO_PROJECT_OWNER` relation to an ACTIVE attachment. Hiding an attachment
revokes that relation immediately; restoring it creates a new collection
revision. Hiding or archiving the project itself does not remove the owner's
private access to an active preserved attachment.
