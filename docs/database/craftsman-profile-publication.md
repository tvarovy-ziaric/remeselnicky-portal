# Craftsman profile publication boundary

R1-010 stores publication control as three independent, append-only axes:

- review: `DRAFT / PENDING / APPROVED / REJECTED`;
- owner preference: `PUBLIC / HIDDEN`;
- moderation: `ALLOWED / HIDDEN / RESTRICTED`.

`current_craftsman_profile_publications.effectively_public` is the authoritative
boundary, not a public-data projection. It fails closed unless the owner account
is active, review is approved, the owner preference is public, moderation is
allowed, and the current profile still satisfies the exact D08 minimum. The
minimum is evaluated dynamically from profile identity/type, About, active
profession with declared level, and current base municipality plus normal
radius. Optional photo/logo, skills, specializations, pricing, portfolio,
experience and credentials never block publication.

Owner hide/unhide changes only the owner preference. Moderation restore changes
only moderation and therefore restores the owner's last legitimate preference.
Low-risk profile edits do not mutate approval. A sensitive identity workflow can
request re-review only through the fixed server-owned
`profile-service:identity-change` command boundary; R1-010 intentionally does
not invent a broader automatic re-review policy.

Admin approval, rejection and moderation require an active role plus a fresh
MFA-backed privileged session. The session, actor, factor and concrete live role
grant are locked with the profile transaction. Every admin transition and the
trusted identity hook requires an exact, minimized unified audit event in the
same transaction. Command and revision timestamps are database-authored, and
both histories reject updates and deletes.

This component exposes no public profile fields. R1-011 must introduce a
separate privacy-reviewed projection and must use this effective boundary. It
must never expose private contact data, exact addresses, identity-verification
references, admin reasons or MFA/session facts.
