# ADR 0007: Domainless Quick Tunnel with a session-based Alpha gate

- Status: Accepted for synthetic testing only
- Date: 2026-09-16
- Last updated: 2026-09-30
- Ticket: R3-022 staging access

## Context

The operator has no Cloudflare-managed DNS zone and requested access through
Cloudflare's free Quick Tunnel. Quick Tunnel issues random public hostnames
without an account, but those hostnames cannot be protected by the planned
Cloudflare Access application policies. A URL is not an authorization boundary.

The first implementation used Nginx server-level HTTP Basic authentication.
That boundary protected the origin, but it challenged every document, API,
React Server Component and static-asset request. Whether the tester saw one
prompt or repeated prompts therefore depended on the browser's Basic Auth
protection-space cache. Quick Tunnel also assigns a new hostname when a
connector is recreated, so cached credentials for the old hostname did not
apply to the replacement. The resulting repeated or apparently random browser
prompts were not caused by a portal or Next.js redirect.

## Decision

Run two independent Quick Tunnel connectors with no restart policy. The app
connector reaches only Nginx port 8082. Nginx protects app and API traffic with
an `auth_request` to a dedicated internal Alpha gate service. A tester submits
username `alpha` and the existing generated password once through the gate's
HTML form. Successful authentication creates an opaque, random, server-side
session with a 12-hour maximum lifetime. Its host-only
`__Host-remeselnicky_alpha_gate` cookie is `HttpOnly`, `Secure`,
`SameSite=Lax` and `Path=/`; it contains neither the password nor portal
identity. Gate restart intentionally invalidates all in-memory sessions.

The gate applies same-origin and one-time CSRF checks to login and logout,
accepts only validated relative return paths, compares credentials without
early-exit string comparison, and rate-limits failed attempts per bounded,
hashed client address. It returns generic failures and emits no credential or
request logging. `/_alpha-gate/logout` invalidates only the outer gate session;
portal authentication remains a separate cookie and authorization boundary.

The object connector remains independent. It reaches only Nginx port 8081,
which has no app or Alpha-gate route and permits only exact opaque
private-object paths with signed GET/HEAD requests. The Alpha gate cookie is
host-only to the app's random hostname and is never sent to the separate
signed-object hostname. Signed media therefore opens without a second Alpha
prompt while its short-lived signature and portal authorization remain
authoritative.

Connector startup discovers the random hostnames and updates only ignored local
alpha configuration before restarting app-origin consumers. Gate credentials
remain in ignored local secret files; no credential is placed in a URL,
repository, browser storage or cookie.

## Boundaries and consequences

- This target is for synthetic internal testing only. The shared Alpha gate is
  not individual tester identity or Cloudflare Access. Portal-level
  authentication and server-side authorization remain authoritative for all
  private entities.
- The gate session is valid for at most 12 hours and only on the current app
  hostname. Restarting the gate or Quick connector, receiving a new Quick
  hostname, explicitly logging out, tampering with the cookie or reaching its
  expiry requires one new Alpha login.
- Both URLs change on connector restart. A stopped connector remains stopped
  until deliberately started again; stale origin configuration fails closed.
- The separate provider-backed staging design is unchanged. A named domain is
  still protected by Cloudflare Access and individual tester policies; its
  Service Auth pair remains its outer automation boundary. The local Alpha
  gate remains an additional origin boundary, while Quick Tunnel has no Access
  layer and relies on that shared gate alone.
- Quick Tunnel has no uptime guarantee, a concurrent-request cap and no SSE.
  It is not a production endpoint or a substitute for D30 staging E2E and
  explicit real-user go/no-go requirements.
- Public smoke probes must cover a fresh browser, one Alpha login, deep-link
  return, refresh/back/forward/new-tab reuse, portal-login independence, gate
  expiry/tamper/logout, object-route denial and one signed-object roundtrip
  without logging the signature or leaving the probe object behind.

## Historical note

The 2026-09-16 revision deliberately chose Nginx HTTP Basic Auth as the first
zero-account boundary. On 2026-09-30 it was replaced by the session-based gate
after browser testing exposed the protection-space and rotating-hostname UX
failure. The password file and security topology were retained; no external
account, DNS zone, paid service or additional personal-data flow was introduced.
