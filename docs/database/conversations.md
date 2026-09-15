# Invitation-scoped conversations

R3-011 introduces the private conversation identity required by D03 and D13.
It deliberately does not store messages; message history, read state and local
archive/mute state belong to R3-012.

## Authority and lifecycle

- A conversation has exactly one immutable `JobInvitation` identity. The
  existing unique request/craftsman invitation constraint therefore also makes
  each request/craftsman conversation private and unique.
- The database creates the conversation in the same transaction that appends
  the first `ENGAGED` invitation revision. A migration backfill covers
  invitations that were historically engaged before deployment.
- A direct insert is accepted only for an invitation with an authoritative
  historical `ENGAGED` revision. The database replaces caller-supplied IDs and
  timestamps, and conversation identities cannot be updated or deleted.
- `current_conversations.access_state` is `WRITABLE` only while the current
  invitation is `ENGAGED`. `NOT_SELECTED`, withdrawn and other terminal
  candidate contexts are `READ_ONLY`; history is preserved.
- R4 quote acceptance will extend the same winning identity into the confirmed
  Job. It must not create a replacement chat.

## Authorization and privacy

The repository accepts only the exact active owner of the invitation's
`CustomerProfile` or `CraftsmanProfile`. Account state, ownership and the
conversation row are checked in one SQL statement. Unknown, pre-engagement,
competitor and foreign IDs all produce the same unavailable result.

The outward API returns only the conversation, invitation and request IDs,
participant perspective, current write-access category, safe counterpart label,
generic request context label and creation time. It does not expose profile-owner IDs,
contacts, exact address, stored messages or competitor data. Responses are
`no-store` and `noindex`.

## Verification

Static and repository tests cover the ENGAGED gate, unique/append-only identity,
current-state-derived write access, active exact-participant authorization and
corrupt-row fail-closed behavior. The clean PostgreSQL integration helper covers
pre-engagement denial, automatic atomic creation, exact command replay,
competitor isolation, terminal read-only history and suspended-account denial.
