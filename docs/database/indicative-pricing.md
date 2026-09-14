# Indicative pricing persistence

R1-007 stores optional, owner-managed craftsman profile price-list rows. Every
active row has a service name, one D08 price mode, an exact positive amount in
integer EUR cents and an optional short note. A row may point to an active
`CraftsmanProfession` owned by the same profile, but the link is deliberately
nullable: descriptive profile pricing is not forced into the profession
taxonomy.

These values are non-binding orientation data. They are not a `Quote`, accepted
commercial total, `Job` snapshot, invoice or payment record. R1-007 exposes no
public projection; later profile publication must use an explicit allowlisted
serializer.

## Safety and authorization

- Commands derive ownership from the authenticated actor and require an
  `ACTIVE` owning User. The database locks the profile/User decision so account
  suspension races fail closed or serialize before the suspension timestamp.
- The optional profession foreign key is checked in both repository and trigger
  code for same-profile ownership and `ACTIVE` state.
- Service/note storage rejects control characters and common email, phone, URL,
  postal/exact-address-label and secret patterns before those fields can later
  become public.
- Currency is fixed to `EUR`; floating-point and PostgreSQL `money` types are
  not used.

## History and retries

ADD, EDIT and ARCHIVE use caller-generated command UUIDs and SHA-256 intent
fingerprints. An exact retry returns the immutable revision produced by the
original command; reuse with different intent fails. Revisions are contiguous,
append-only snapshots. Identity and creation provenance cannot be rewritten,
and hard deletion/unarchive are rejected.

Listing is owner-only and deterministic by `(created_at, id)`. There is no
arbitrary row-count limit; archiving keeps history while the normal list hides
archived rows.
