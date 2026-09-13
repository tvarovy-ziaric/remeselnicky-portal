# Server-side field projections

R0-014 introduces an explicit response projection boundary in `@portal/projections`. Route handlers
must first obtain a server-side authorization decision, then select a named view and serialize only
fields registered in a projection plan. They must never spread a persistence/domain object into an
API response.

The foundation supports four view families:

- `PUBLIC` contains intentionally public fields only.
- `PRIVATE` is for an authorized owner/private view.
- `CONTEXTUAL` grants contact data and exact address independently; an invitation alone grants neither.
- `ADMIN` separates sensitive operational data from internal notes/risk flags by capability.

Recognizable contact/address keys cannot be declared public, and internal-note/risk-flag keys can only
use the admin-internal audience. This runtime check is defense in depth; code review and projection
tests remain mandatory because renaming sensitive content does not make it public.

Projection views are server-created after a `PERMIT` decision. A denied decision cannot create a
private/context/admin view, forged plain JSON view objects are rejected, unregistered source fields
are never copied, and projection exceptions expose a generic error without source values.

Concrete feature DTOs should define their own plans and negative tests. In particular, there must be
no generic public `CustomerProfile` serializer, and pre-confirmation request/invitation projections
must not grant `CONTACT` or `EXACT_ADDRESS`.
