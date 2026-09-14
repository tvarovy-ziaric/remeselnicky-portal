# ADR 0005: Provider-neutral admin MFA and separate privileged sessions

- Status: Accepted for the R0 foundation
- Locked references: D23, D26, D30

## Context

Admin accounts use the normal identity platform but need mandatory stronger
authentication, capability-scoped authority, recent reauthentication for role
changes and append-oriented provenance. Choosing an external MFA vendor or
production credential is a human gate, while the application boundary must be
implementable and testable before that choice.

## Decision

Use a narrow `AdminMfaProvider` port for TOTP/WebAuthn challenge and
verification. Persist opaque provider references, one-shot challenge digests
and separate short-lived privileged sessions bound to the normal revocable
session. Derive capabilities from current server-side role grants on each
authorization. Keep role changes as dedicated commands with a recent-MFA check,
transactional persistence recheck and immutable event.

The provider adapter owns MFA secrets and recovery material. The portal does
not implement TOTP cryptography or store recovery codes. Production registers
no admin routes until a real adapter is explicitly wired.

## Consequences

- A normal login is never sufficient for privileged access.
- Role/factor/account/base-session revocation takes effect without trusting a
  stale frontend or signed role claim.
- Vendor selection and first production enrollment remain explicit D30 gates,
  while tests can use an in-memory adapter through the same port.
- Feature-specific admin policies remain necessary; this foundation grants no
  generic access to domain data or mutations.
