# Temporary public alpha/staging target

This runbook operates a **temporary public alpha/staging target for internal
testers** on one Windows laptop. It is not production, has no SLA and contains
synthetic data only. A named tunnel uses Cloudflare Access plus a high-entropy
Nginx Basic Auth gate; a domainless Quick Tunnel has only the Basic Auth gate.
Both still require the portal's own invite-only authentication. Quick Tunnel is
not an Access replacement or a real-user launch route.

## Components, accounts and cost

| Component                     | Exact role                                                                                             | Account/credential                                                            | Expected direct cost                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Docker Desktop + WSL2         | Local container runtime                                                                                | Docker terms must be accepted; sign-in is not required for the stack          | EUR 0 only when the operator qualifies for Docker Desktop's free personal/small-business terms |
| `web`, `api`, `worker` images | Production builds of this repository                                                                   | Local generated secrets only                                                  | EUR 0                                                                                          |
| PostGIS 17 / PostgreSQL 17    | Isolated alpha database and durable queues                                                             | Separate owner and runtime passwords under `.alpha/secrets`                   | EUR 0                                                                                          |
| MinIO S3-compatible server    | Private object store, built from the final open-source security release `RELEASE.2025-10-15T17-29-55Z` | Local access/secret key                                                       | EUR 0; AGPLv3 obligations and the archived/unmaintained status apply                           |
| MinIO `mc` CLI                | Bucket initialization and isolated backup/restore, built from `RELEASE.2025-08-13T08-35-41Z`           | Reuses the local MinIO credentials                                            | EUR 0; source-built because the published Docker image is unavailable                          |
| ClamAV 1.5.4                  | PDF malware verdict, loopback sidecar to worker                                                        | None                                                                          | EUR 0                                                                                          |
| Nginx 1.28                    | Tunnel origin, Basic Auth gate and localhost diagnostic endpoint                                       | Local generated gate password                                                 | EUR 0                                                                                          |
| `cloudflared` 2026.9.1        | Outbound-only named tunnel or two domainless Quick Tunnels                                             | Named: Cloudflare token; Quick: none                                          | EUR 0                                                                                          |
| Cloudflare Access             | Tester allowlist and E2E Service Auth                                                                  | Cloudflare account, an active DNS zone, tester identities, service token pair | EUR 0 for the Free plan up to 50 users                                                         |

Current commercial terms must be checked by the operator before installation.
Docker documents when Desktop is free at
<https://docs.docker.com/desktop/setup/install/windows-install/>. Cloudflare's
current Zero Trust pricing is at
<https://www.cloudflare.com/plans/zero-trust-services/>. No script in this
repository creates a subscription, accepts an agreement or enters billing
details.

MinIO's upstream repository was archived in April 2026 and its community
release is no longer maintained. The alpha builds the last public security
release from source rather than pulling an older server binary. Its S3 API is
still protected by a private bucket, SigV4, method restrictions and an
exact opaque-key path allowlist. This residual risk is acceptable only for this
short-lived, synthetic, internal-tester alpha. It blocks production use and
must be revisited before D30 production approval. The corresponding source is
<https://github.com/minio/minio/tree/RELEASE.2025-10-15T17-29-55Z>.

## Security topology

```text
tester / E2E
  -> named tunnel + Cloudflare Access + Basic Auth, or Quick Tunnel + Basic Auth
  -> alpha-edge network -> Nginx
       -> web :3000
       -> API :3001
       -> exact signed GET/HEAD only -> MinIO :9000

internal Docker network (not joined by cloudflared):
  API/worker -> TLS PostGIS
  API/worker -> TLS MinIO private buckets
  worker + ClamAV share loopback network namespace
```

PostgreSQL, MinIO, MinIO Console, ClamAV and application monitoring ports have
no host publication. The sole host port is `127.0.0.1:8080` for diagnostics.
The tunnel uses outbound connections only; no router port, UPnP or broad
firewall rule is needed. All long-lived secrets live in ignored files under
`.alpha/secrets`. Service TLS keys live under ignored `.alpha/tls`.
Both alpha hostnames emit `Cache-Control: no-store` and
`X-Robots-Tag: noindex, nofollow, noarchive` at Nginx, including error
responses. Nginx access logs are disabled so signed URL query strings are
not retained in proxy logs; API/worker structured logs remain enabled.

Quick mode has two separate random `trycloudflare.com` names. The app tunnel
reaches only Nginx port 8082 and requires Basic Auth for app/API paths. The
object tunnel reaches only port 8081, which serves exact signed private object
paths with GET/HEAD only; it cannot route to the app even with a forged Host
header. Neither port is published on the host. Cloudflare Access policies are
not available for these random names. A shared gate password is suitable only
for a small trusted synthetic-data test, never as a substitute for individual
tester identity or a real-user release decision.

`portal-alpha-private` is private. The media lifecycle is logical and audited:
an `ORIGINAL_UPLOAD` object is quarantined while the asset is `PROCESSING`; a
clean scan authors a byte-identical private `CANONICAL` object and moves the
asset to `READY`; malware or invalid content moves it to `REJECTED` without a
deliverable canonical object. Only `READY` plus an exact current authorization
grant produces a 1–300 second signed GET. The second derivative bucket also
remains private in this R3 target.

The local alpha ClamAV database also loads a test-only signature for the
standard EICAR string when embedded inside a PDF. ClamAV's default standalone
EICAR signature does not match that embedded fixture. This additional
signature makes the PDF quarantine/rejection E2E probe meaningful; it is not a
claim that one synthetic marker measures production malware-detection quality.

The portal limits images to 15 MiB and PDFs to 25 MiB. Both are below
Cloudflare Free's current 100 MB HTTP request limit
(<https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/>),
so this target neither changes product limits nor needs multipart uploads.

## First local start

Prerequisites on Windows:

1. Enable WSL2 and Virtual Machine Platform from an elevated terminal, reboot
   if Windows requests it, and install Docker Desktop using the WSL2 engine.
2. Allocate at least 6 GiB RAM to Docker; 8 GiB is recommended because ClamAV
   alone is capped at 4 GiB.
3. Keep at least 20 GiB free disk. Disable sleep/hibernation while testers use
   the alpha.
4. Review Docker Desktop's license and do not continue if free use is not
   applicable.

Initialize generated secrets and internal TLS:

```powershell
pwsh ./infra/alpha/Alpha.ps1 -Action init
pwsh ./infra/alpha/Alpha.ps1 -Action config
pwsh ./infra/alpha/Alpha.ps1 -Action start
pwsh ./infra/alpha/Alpha.ps1 -Action status
```

The default `*.invalid` names are intentionally local-only placeholders. A
healthy local stack is necessary before public tunnel provisioning. The first
ClamAV signature download and MinIO source build can take several minutes.

The seed is deterministic, idempotent and staging-only. It creates seven
synthetic identities such as `synthetic.account.101@portal.invalid`, one
synthetic governed taxonomy release, one synthetic municipality, and two
admin-reviewed PUBLIC test profiles (individual and company). It refuses to
replace a different current taxonomy or run outside the explicit staging
fixture mode. These profiles are exclusively for internal isolation tests; the
short-lived seeded privileged admin session simulates completed MFA only for
this test fixture and is not a user login. The accounts' shared generated
password remains in
`.alpha/secrets/synthetic_seed_password` and must not be pasted into tickets or
logs. The broader R3 competitor/media fixture is provisioned separately by the
public E2E preparation step; do not use migration integration fixtures as
persistent staging data.

Once both Quick Tunnels are healthy, provision the private R3 fixture through
the public HTTPS app boundary and run the browser suite:

```powershell
node ./apps/e2e/scripts/provision-r3-quick.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File ./apps/e2e/scripts/run-r3-quick.ps1
```

The provisioner uses only synthetic accounts and writes fixture IDs and
short-lived authenticated browser storage states under ignored `.alpha/`.
Treat those storage-state files as credentials: never commit, paste, email or
share them. The runner includes a controlled worker stop/start to verify
quarantine durability. Portal login rate limiting remains enabled; if a run
hits `429`, wait for the configured window rather than disabling the boundary.
The suite needs Playwright's Chromium, Firefox and WebKit binaries; install
missing engines with `pnpm --filter @portal/e2e exec playwright install`.

## Domainless Quick Tunnel (no Cloudflare account)

From a healthy local stack, start both free temporary tunnels:

```powershell
pwsh ./infra/alpha/Alpha.ps1 -Action quick-start
```

The command prints the app and signed-object URLs and updates the ignored
`.env.alpha` origins. Open the app URL in a browser. The first gate asks for
username `alpha` and the generated password stored only in
`.alpha/secrets/quick_gate_password`. Read that file locally; do not paste the
password into a ticket or chat. The portal still requires its own synthetic
account login. On `/prihlasenie`, replace any browser-autofilled `alpha` in
the E-mail field with `synthetic.account.101@portal.invalid` (synthetic
customer). Its separate password is in
`.alpha/secrets/synthetic_seed_password`; read it locally and do not paste it
into a ticket or chat. The `.invalid` address has no mailbox and is used only
for this synthetic staging fixture. Use only approved internal testers and
synthetic data.

If Quick Tunnel assigns a different hostname while an R3 browser fixture
already exists, rerun `provision-r3-quick.mjs` before the browser suite. It
accepts only a previous Quick Tunnel origin, verifies the existing synthetic
requests still belong to the same two accounts on the new origin, and then
rebinds the ignored fixture/auth states. A missing or foreign request fails
closed instead of silently creating a replacement fixture.

Quick Tunnel URLs are random, change after connector restart, have no uptime
guarantee, support at most 200 concurrent in-flight requests, and do not
support SSE. If either connector stops, run `quick-start` again and distribute
the new app URL; old signed URLs are invalid. To remove public reachability:

```powershell
pwsh ./infra/alpha/Alpha.ps1 -Action quick-stop
```

For local browser E2E against the current Quick app URL, additionally set
`STAGING_E2E_BASIC_AUTH_USERNAME=alpha` and load
`STAGING_E2E_BASIC_AUTH_PASSWORD` from the ignored password file into the
current process. Do not set the Cloudflare Access client-ID/secret variables
in Quick mode. A passing Quick run is useful public-network evidence but does
not verify a named Access-protected staging deployment or satisfy D30's
real-user launch gates.

Verify the exact signed-object route without exposing a signed URL or leaving
the probe object behind:

```powershell
docker compose --env-file .env.alpha -f compose.alpha.yaml --profile ops run --rm --no-deps quick-object-probe
pnpm --filter @portal/e2e exec node scripts/quick-smoke.mjs
```

The second command opens the authenticated Quick app in headless Chromium. Run
`pnpm --filter @portal/e2e exec playwright install chromium` once if its
browser runtime is not installed.

Cloudflare documents the no-account URL, 200-request cap, lack of SSE and
testing-only status in its [Quick Tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Cloudflare provisioning (manual credential boundary)

These actions create no paid product when the existing account/zone remains on
the Free plans described above:

1. Add or identify the Cloudflare-managed domain. Choose two hostnames, for
   example `alpha.example.sk` and `objects-alpha.example.sk`.
2. In **Networking > Tunnels**, create the remotely managed named tunnel
   `remeselnicky-alpha`.
3. Add two public hostnames to that tunnel. Both services point to
   `http://reverse-proxy:8080`:
   - `alpha.example.sk`
   - `objects-alpha.example.sk`
4. In **Zero Trust > Access > Applications**, protect both exact hostnames.
   Add an Allow policy containing only approved tester emails. Do not create a
   bypass policy.
5. In **Access > Service credentials > Service Tokens**, create
   `remeselnicky-alpha-e2e` with the shortest practical lifetime. Add a
   **Service Auth** policy for that token to both applications. Cloudflare
   documents the required headers at
   <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>.
6. Copy the tunnel token, Access Client ID and one-time Client Secret only into
   the secure prompts:

```powershell
pwsh ./infra/alpha/Initialize-Alpha.ps1 `
  -AppHostname alpha.example.sk `
  -ObjectHostname objects-alpha.example.sk
pwsh ./infra/alpha/Set-CloudflareSecrets.ps1
pwsh ./infra/alpha/Alpha.ps1 -Action tunnel-start
```

Never paste the whole token into chat, Git, `.env.alpha`, Compose YAML or a
command-line argument. A remotely managed tunnel token can run a connector and
must be rotated immediately if exposed.

## Public verification

Set E2E variables only in the current process or a local ignored secret loader.
The two Access values are an exact pair:

```powershell
$env:STAGING_E2E_ENABLED = "true"
$env:STAGING_E2E_BASE_URL = "https://alpha.example.sk"
$env:STAGING_E2E_CF_ACCESS_CLIENT_ID = Get-Content .alpha/secrets/cf_access_client_id -Raw
$env:STAGING_E2E_CF_ACCESS_CLIENT_SECRET = Get-Content .alpha/secrets/cf_access_client_secret -Raw
$env:STAGING_E2E_BASIC_AUTH_USERNAME = "alpha"
$env:STAGING_E2E_BASIC_AUTH_PASSWORD = Get-Content .alpha/secrets/quick_gate_password -Raw
$env:STAGING_E2E_LOCAL_COMPOSE_CONTROL = "true"
pnpm --filter @portal/e2e test
```

The committed suites verify real HTTPS/session/CSRF competitor isolation and,
once the referenced synthetic R3 IDs are supplied, clean PDF quarantine ->
READY -> authorized signed download, competitor/anonymous denial, EICAR ->
REJECTED, and durable processing across a worker stop/start. E2E is not green
until those tests actually run against the public hostname on Chromium,
Firefox and WebKit as applicable.

Also verify from a machine outside the laptop that ports 5432, 9000, 9001,
3310, 9464 and 9465 are unreachable. Requests to the object hostname outside
the exact signed private path must be Access-denied or 404; unsigned exact paths
must be 403 and must not list bucket contents.

## Operations

```powershell
# Health/status and redacted recent logs
pwsh ./infra/alpha/Alpha.ps1 -Action status
pwsh ./infra/alpha/Alpha.ps1 -Action logs

# Safe app restart, current-checkout update, last-image rollback
pwsh ./infra/alpha/Alpha.ps1 -Action restart
pwsh ./infra/alpha/Alpha.ps1 -Action update
pwsh ./infra/alpha/Alpha.ps1 -Action rollback

# Backup and non-destructive restore verification into clone DB/buckets
pwsh ./infra/alpha/Alpha.ps1 -Action backup -BackupId 20260916T120000Z
pwsh ./infra/alpha/Alpha.ps1 -Action restore-clone -BackupId 20260916T120000Z

# Immediately remove public reachability, then stop containers
pwsh ./infra/alpha/Alpha.ps1 -Action tunnel-stop
pwsh ./infra/alpha/Alpha.ps1 -Action stop
```

Each `update` uses a unique image tag, including for an uncommitted worktree, so
the previous images remain available for rollback. Backup IDs cannot overwrite
an existing local backup; restore clones use a deterministic short hash of the
ID for database and S3 bucket names, avoiding provider name-length limits.

`stop` retains named volumes. No provided command deletes a database, bucket or
volume. `restore-clone` never overwrites the active alpha. Backups land under
`backups/alpha/` (ignored), but a copy on the same laptop is not disaster
recovery: copy an encrypted backup off-device before inviting testers. That
off-device copy remains an explicit unsatisfied operational step until an
approved destination exists.

Docker Desktop can be configured to start at sign-in, and containers use
`restart: unless-stopped`. Do not enable automatic tunnel startup until Access
policies have been tested. After reboot, confirm Docker, all healthchecks,
Access denial and signed-media denial before announcing availability.

## Classification and release boundary

- local implementation complete: only after repository checks and local
  Compose/media verification pass;
- public alpha/staging deployed: only after both Access-protected hostnames are
  reachable through the named tunnel;
- staging E2E verified: only after the public-host suites, clean/EICAR pipeline,
  restart durability and external port checks pass;
- production deployment not performed: always true for this runbook.
