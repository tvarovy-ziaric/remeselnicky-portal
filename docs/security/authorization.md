# Server-side authorization foundation

`@portal/authorization` is the framework-independent R0-013 boundary for
private policy evaluation and explicit public-operation allowlisting. It
implements the locked D02, D23 and D26 default-deny rules without defining a
role or marketplace permission matrix ahead of the relevant feature tickets.

## Trust boundary

Route location, UI state, IDs and client claims are never authority. A server
adapter performs these steps in order:

1. select a server-owned policy constant for the route command;
2. load the current `User` and create the actor with
   `createAuthenticatedAuthorizationActor`;
3. resolve the target through authorized persistence code, using
   `unresolvedAuthorizationTarget()` when no row is found;
4. assemble relationship/capability facts from server-owned data with
   `createServerAuthorizationContext`;
5. call the evaluator and continue only for an explicit `PERMIT` result.

The actor constructor copies only `UserId` and the current account state.
Client-supplied role, owner, participant or admin claims are not copied.
Adapters must never call the actor, target or context constructors directly on
an unvalidated request body. The marker-based wrappers are a guard against
accidental raw-object use, not a replacement for loading authoritative state.

Private target lookup must happen before policy evaluation. Knowledge of an
opaque ID is therefore insufficient: an unresolved target fails closed without
calling its policy. Feature repositories must not return another user's object
merely because an ID exists.

## Policies

Policies are immutable server constants defined with
`defineAuthorizationPolicy`. Each definition has a stable lowercase resource
identifier, a distinct action identifier, a required account state and typed
target/context values. Read and write use separate policy definitions; a permit
for one action does not imply any other action.

`AUTHENTICATED` policies may evaluate legitimate read/history cases according
to their later locked feature rules. `ACTIVE` policies are centrally denied
when the freshly loaded account is `SUSPENDED` or `DEACTIVATED`, before feature
policy code runs. Feature tickets must mark every D02-prohibited new
marketplace command as `ACTIVE`; they must not cache account state in a session.

The generic context can later carry typed, server-loaded facts for Job,
Invitation, Conversation, Quote, participant/workgroup relationships, field
access or named admin capabilities. This package deliberately has no generic
role-string grant and no concrete permission matrix. R0-012 and feature tickets
define their own closed capability/action vocabularies under their locked
rules.

R4-025 finalizes the cross-release composition in
[`../testing/r4-final-permission-matrix.md`](../testing/r4-final-permission-matrix.md).
The session boundary reloads current D24 restriction scopes for every request,
and migration `0107_final_permission_matrix.sql` independently guards explicit
R1-R4 mutation ingress tables. Feature restrictions do not erase authorized
historical reads, and appeal/privacy/privileged correction planes keep their own
separate policies.

An evaluator registers policies by object identity. A missing definition,
another definition with the same textual key, anonymous actor, untrusted actor
or context, unresolved target, explicit policy denial, invalid result, thrown
error or rejected promise all produce `DENY`. Duplicate registered textual keys
are a startup configuration error.

## Public operations

Anonymous access is separate from private policies. Every public endpoint owns
a `definePublicOperation` constant, and the server composition root passes only
approved constants to `createPublicAccessAllowlist`. A similarly named but
unregistered constant and any raw client value are denied. API integration must
map the allowlist decision to routing; it must never infer public access from an
absent private policy.

## Safe decisions and logging

Authorization decisions contain only `effect` and a closed reason code. They do
not contain actor IDs, target IDs, context, policy exceptions or payloads, so
the decision itself is safe structured telemetry. Stable policy/public
identifiers are validated to prevent request data or PII from becoming log
labels. Do not log complete authorization inputs.

HTTP adapters should expose a generic forbidden/not-found response appropriate
to the feature's anti-enumeration boundary. Internal reason codes are not a
promise to reveal resource existence to clients.
