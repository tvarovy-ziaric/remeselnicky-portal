# Object storage topology

R0-016 defines a provider-neutral storage boundary. It does not select a cloud vendor or implement the
media validation pipeline owned by R0-017/R0-018.

## Isolation contract

- `private` contains canonical Job, chat, dispute, credential and other non-public objects. The
  infrastructure adapter must disable anonymous read and bucket/container listing.
- `public-derivative` contains only explicitly published, canonical derivatives. It uses a separate
  container and delivery path so moderation can revoke publication without deleting provenance.
- Object keys are generated on the server from an area, UTC partition and UUID. Original client
  filenames are never storage paths.
- Storing a private object returns no delivery URL. Delivery requires an affirmative server-side
  authorization decision and an adapter-issued grant lasting at most five minutes.
- Signed/private download URLs are bearer secrets and must not appear in logs, analytics or events.

Environment-specific container names and credentials stay in server-only configuration. The adapter
must apply private access policy at infrastructure provisioning time; application checks are an
additional boundary, not a replacement for private storage policy.
