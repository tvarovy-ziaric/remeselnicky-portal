# Conversation chat and participant state

R3-012 builds the private transactional timeline on top of the immutable
invitation-scoped `Conversation` identity from R3-011.

## Authority and isolation

- A human message can be inserted only by an `ACTIVE` owner of the exact
  customer or craftsman profile attached to that conversation.
- Human messages require the current conversation access state to be
  `WRITABLE`, which currently means the invitation is `ENGAGED`.
- The timeline remains readable to the two exact participants after the
  invitation becomes terminal, but sending returns `READ_ONLY`.
- There is no general direct-message lookup, recipient field, group membership
  or competitor-visible thread.

## Append-only timeline

`conversation_timeline_entries` contains distinct `HUMAN_MESSAGE` and
`SYSTEM_EVENT` entries. Human messages are derived from an idempotent command;
the initial engagement event is tied to the exact immutable invitation
revision that entered `ENGAGED`. Database triggers assign message identity,
sequence and timestamps and reject update/delete operations.

Alpha messages are plain text with line breaks and ordinary emoji. HTML and
Markdown are not interpreted. The web client may render explicit `http`/`https`
tokens as external links with `nofollow noreferrer`; persisted content remains
plain text. Corrections are new messages. Lightweight reply provenance is an
optional same-conversation message reference.

The server currently applies a conservative pre-confirmation guard to obvious
email addresses, phone numbers, postal codes and address labels in both the
domain admission and database command boundary. R3-014 will replace that
temporary function with the complete Job-confirmation-aware warning/masking/
blocking policy. General external URLs are not treated as contact identity by
this narrow baseline.

## Read, archive and mute state

Each participant has independent append-only state revisions. `last_read_at`
semantics are represented more precisely as the highest read timeline
sequence, avoiding equal-timestamp ambiguity. Unread count includes only
counterparty human messages beyond that marker. A sender sees a simple
counterpart-read boolean derived from the counterpart's marker.

Archive and mute are presentation/notification preferences only. They do not
change invitation, request or future Job state and never remove timeline
history. Critical notification overrides remain governed by D25/R4-024.

## Reports and privacy

A participant may report the exact conversation or one exact message using a
bounded category. R3-012 deliberately stores no duplicate message body or
free-text report note. Moderation queue/action/appeal and auditable privileged
content access remain R4-023 work; creating a report itself does not grant an
admin unrestricted chat access.

Message bodies are private transactional data. They are excluded from logs,
notification previews, report rows and public projections. Retention values
remain a D27 legal-policy gate; neither user archive nor moderation may silently
hard-delete business history.
