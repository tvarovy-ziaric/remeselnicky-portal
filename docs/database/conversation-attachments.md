# Conversation attachments (R3-013)

Chat attachments are private media bound to one immutable human message. The
message must already exist and must have been authored by the uploader; the
alpha composer therefore sends text first and then attaches the selected files
to that source message. Attachment-only messages are not introduced here.

## Authority and races

Only the server-side upload authorization repository may mint
`CONVERSATION_MESSAGE` provenance. Both preparation and the `media_assets`
insert guard serialize on the ACTIVE actor and `job_invitations` identity before
re-reading the current invitation state. They then require the exact current
conversation member, `WRITABLE` access, the uploader's own `HUMAN_MESSAGE`, and
the immutable message sequence. This second database guard closes the gap
between storing the private object and inserting its metadata; a rejected race
is reported to the central orphan-object observer.

Migration 0046 also replaces the R3-012 message-command guard with the same
actor/invitation serialization order. A message or attachment may linearize
before a terminal invitation transition, but never after it. Historical chat
rows and attachment provenance remain append-only.

The technical abuse bound is 10 attachment attempts per message, of which at
most 5 may be images. `PROCESSING`, `READY`, and `REJECTED` attempts all consume
a slot so repeated rejected uploads cannot bypass the bound. The user can send
a new text message as the retry path. These values are safety limits, not Job,
crew, delivery, or product-capacity promises.

## Processing and delivery

Accepted formats are JPEG, PNG, HEIC/HEIF and PDF. Uploads use the central
private object-storage boundary and existing image canonicalization or PDF
validation/malware-scan dispatcher. Video and voice are not accepted. Timeline
DTOs expose only:

- opaque media asset ID;
- `IMAGE` or `PDF`;
- `PROCESSING`, `READY`, or `REJECTED`;
- server-authored upload timestamp.

They never expose an object key, hash, original bytes, public URL, contact data,
or address. A `READY` asset is delivered only through the private media service.
That service performs its existing double-read authorization and the
conversation resolver rechecks an ACTIVE exact current participant each time.
Terminal `READ_ONLY` members retain their history; competitors, suspended
accounts, processing/rejected assets, and revoked canonical objects receive the
same not-found result. Responses are private/no-store, nosniff, and redirect to
a short-lived cross-origin private grant. If no production storage provider is
configured, upload and delivery endpoints fail closed with 503; no synthetic
production adapter is installed.

All conversation writes use two database-backed admission buckets after the
ACTIVE session guard: a stable actor/action digest and a separate IP/action
digest. Raw user IDs and IP addresses are SHA-256 hashed before persistence.
The IP ceiling is five times the configured account ceiling to tolerate shared
NATs while retaining a separate abuse boundary.

## Future confirmed-Job hook

`conversation_job_media_candidates` is a privacy-minimal candidate view. It
contains only conversation ID, source message ID, media asset ID, uploader ID,
kind and `chronological_at` (`captured_at` when centrally recovered, otherwise
upload time). It includes only READY assets with a live private canonical
object. The view has no Job ID, storage fields, public-delivery authority, or
claim that a Job exists. A future confirmed-Job layer must independently join
the winning conversation, re-authorize participants, and then build the
chronological photo/document stream.

The standalone live PostgreSQL helper is wired into the single clean migration
runner. It exercises provenance spoofing, bounds, suspension and terminal-state
races, chronological fallback, revocation, competitor denial, and terminal
member history. It runs only when `TEST_DATABASE_URL` is provided.
