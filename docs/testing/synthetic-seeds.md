# Synthetic seed data and factories

`@portal/testing` owns deterministic R0 fixtures for the D30 integration/E2E
scenarios. The catalog covers customer-only, individual and company craftsman,
combined, admin, superadmin and suspended accounts. Every record is explicitly
`synthetic: true`; its analytics actor is always `is_test: true`. Seeded emails
use the reserved `.invalid` suffix and IDs live in a fixed synthetic UUID range.

Customer and craftsman are independent profile capabilities, not exclusive
account roles. R0 records the intended profile shape in the fixture descriptor.
R1 profile tables must consume that shape when their schemas land. Until then,
the PostgreSQL adapter writes only the existing identity/auth/admin tables and
does not pretend that a profile exists.

The Slovak-location mechanism validates stable `SK:` codes, parent references,
duplicates and cycles. Its checked-in entries are visibly synthetic test areas,
not a claim about the final geographic catalog. Likewise, `TEST:` profession
entries are mandatory placeholders; final taxonomy content remains owned by R1.

## Safe execution

Build and invoke the package runner from the repository root:

```powershell
$env:APP_ENV = "staging"
$env:DATABASE_URL = "<staging database URL>"
$env:SYNTHETIC_SEED_PASSWORD_HASH = "<precomputed test-only password hash>"
pnpm --filter @portal/testing seed:synthetic
```

There is deliberately no checked-in password, token, OTP, MFA secret or default
credential. The runner accepts only an injected hash and never prints it. The
same deterministic hash must be reused for repeat execution; a mismatch with an
existing fixture fails rather than silently changing credentials.

The runner rejects `production`, missing and unknown environments before opening
a database connection or reading credential material. It then requires the
database-side `portal.environment` setting to exactly match `APP_ENV` before the
first write. Configure the dedicated non-production role, for example:

```sql
ALTER ROLE portal_staging_app SET portal.environment = 'staging';
```

Use a least-privilege staging/development role. Never set a production role's
marker to a non-production value. Inserts are transaction-scoped, stable-keyed
and conflict checked. A repeat run returns `UNCHANGED`; unexpected active admin
roles/factors or identity collisions fail closed. Output contains counts and the
synthetic data class only—no account or credential details.

Feature analytics must use the fixture's `analyticsActor`; it carries
`is_test: true`, allowing all synthetic accounts to be excluded from production
marketplace KPIs. The runtime production guard provides a second boundary: this
runner cannot create these accounts in production.
