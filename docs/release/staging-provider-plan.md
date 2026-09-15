# Isolated staging provider plan

Status: proposal only. No account, subscription, billable resource, credential or
DNS record has been created by this plan.

Pricing was checked on 2026-09-15. Amounts are DigitalOcean list prices in USD,
excluding tax, domain registration and usage above included quotas.

## Recommendation

Use one isolated DigitalOcean project in `fra1`, separate from any future
production project. It matches the existing Kubernetes/Kustomize,
PostgreSQL/PostGIS and S3-compatible storage contracts without changing product
semantics.

| Component                       | Proposed staging size                                                                                         |           Monthly list price |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------: |
| DigitalOcean Kubernetes         | One non-HA Basic node, 2 vCPU / 8 GiB / 160 GiB                                                               |                       $48.00 |
| DigitalOcean Load Balancer      | One ingress load balancer                                                                                     |                       $12.00 |
| Managed PostgreSQL              | Basic Regular, 1 vCPU / 1 GiB / 10 GiB                                                                        |                       $15.15 |
| Spaces Standard Storage         | Private, public-derivative and IaC-state buckets within one subscription; 250 GiB and 1 TiB outbound included |                        $5.00 |
| DigitalOcean Container Registry | Basic, five repositories / 5 GiB                                                                              |                        $5.00 |
| cert-manager + Let's Encrypt    | In-cluster, pinned versions                                                                                   |                        $0.00 |
| ClamAV                          | Official pinned container, in-cluster                                                                         |           $0.00 license cost |
| Prometheus Operator stack       | In-cluster, bounded retention                                                                                 |           $0.00 license cost |
| GitHub Actions                  | Existing allowance; no new plan proposed                                                                      | $0.00 while within allowance |
| **Expected baseline**           |                                                                                                               |             **$85.15/month** |

The cluster is deliberately single-node and therefore not highly available.
That is acceptable only for an isolated, synthetic-data staging environment.
Two nodes would raise the baseline to `$133.15/month`. DigitalOcean recommends
at least two nodes where upgrade/maintenance downtime is unacceptable.

A 4 GiB node would lower the baseline by `$24/month`, but is not recommended:
ClamAV documents 3 GiB minimum and 4 GiB preferred RAM for its container alone.
The 8 GiB node leaves a bounded remainder for web, API, worker, ingress and
monitoring. Resource use must still be measured before declaring the size final.

Official pricing and capability references:

- [DigitalOcean Kubernetes pricing](https://www.digitalocean.com/pricing/kubernetes)
- [Managed PostgreSQL pricing](https://www.digitalocean.com/pricing/managed-databases)
- [Spaces pricing](https://docs.digitalocean.com/products/spaces/details/pricing/)
- [Container Registry pricing](https://docs.digitalocean.com/products/container-registry/details/pricing/)
- [Managed PostgreSQL PostGIS support](https://docs.digitalocean.com/products/databases/postgresql/details/supported-extensions/)
- [ClamAV container sizing](https://docs.clamav.net/manual/Installing/Docker.html)
- [GitHub plan allowances](https://docs.github.com/en/billing/reference/product-usage-included)

## Accounts and ownership required

1. A new DigitalOcean Team owned by the organization, with billing controlled
   by a named human owner and secure sign-in required for every member.
2. Existing GitHub organization/repository administration access to configure a
   protected `staging` Environment, secrets, variables and required reviewers.
3. Existing DNS account access for `staging.<approved-domain>` and
   `media-staging.<approved-domain>`. No new domain purchase is proposed.
4. An existing alert destination capable of receiving an HTTPS webhook. No new
   paid alerting or email-delivery vendor is proposed.
5. Two named recovery custodians for DigitalOcean/GitHub 2FA recovery material.

DigitalOcean recommends 2FA and can require secure sign-in for a Team:
[account 2FA](https://docs.digitalocean.com/platform/accounts/2fa/) and
[Team secure sign-in](https://docs.digitalocean.com/platform/teams/how-to/require-secure-sign-in/).

## Credentials and configuration

No credential is shared between staging and production. All values are created
only after the billable provisioning approval.

### Human and infrastructure identities

- A narrowly scoped DigitalOcean infrastructure token for OpenTofu/Terraform;
  it is not mounted into application pods.
- A separate read/write registry credential for GitHub Actions image pushes.
- A read-only registry pull identity integrated with the staging cluster.
- A namespace-scoped Kubernetes deploy ServiceAccount. Its kubeconfig is stored
  as GitHub secret `KUBE_CONFIG_STAGING_B64`; no cluster-admin kubeconfig enters
  CI.
- A separate limited-access Spaces key scoped to the three staging buckets.
  The application key receives object read/write/delete only for the private and
  public-derivative buckets; the IaC-state key is separate.

DigitalOcean supports bucket-scoped limited keys with per-bucket permissions.
They are incompatible with bucket policies, so this plan uses private bucket
listing plus explicit private/public object ACLs instead of `PutBucketPolicy`:
[Spaces access management](https://docs.digitalocean.com/products/spaces/how-to/manage-access/).

### GitHub `staging` Environment

Variables:

- `STAGING_IMAGE_PREFIX=registry.digitalocean.com/<registry>/portal`

Secrets:

- `REGISTRY_HOST=registry.digitalocean.com`
- `REGISTRY_USERNAME`
- `REGISTRY_PASSWORD`
- `KUBE_CONFIG_STAGING_B64`
- infrastructure token and encrypted-state key, available only to the separate
  provisioning workflow

### Kubernetes namespace `portal-staging`

`portal-runtime-secrets`:

- `DATABASE_URL`: TLS-verified, least-privilege application role
- `SESSION_SECRET`: generated random value of at least 48 bytes
- `OBJECT_STORAGE_ACCESS_KEY_ID`
- `OBJECT_STORAGE_SECRET_ACCESS_KEY`

Separate secrets:

- `MIGRATION_DATABASE_URL`: schema-owner role used only by the migration Job;
  the current deployment manifest must be changed to stop reusing runtime DB
  credentials before provisioning
- `portal-critical-alert-channel/webhook-url`
- an internal scanner service token if the HTTP scanner boundary is retained
- ACME account material managed by cert-manager

Non-secret ConfigMap values:

- `OBJECT_STORAGE_ENDPOINT=https://fra1.digitaloceanspaces.com`
- `OBJECT_STORAGE_REGION=fra1`
- `OBJECT_STORAGE_FORCE_PATH_STYLE=false`
- distinct private and public-derivative bucket names
- `OBJECT_STORAGE_PUBLIC_BASE_URL=https://media-staging.<approved-domain>/`
- public web/API origins, release SHA and scanner service endpoint

## Security boundaries

- The Team project, VPC, cluster, database, buckets, registry and credentials are
  staging-only. They receive synthetic test data only and have no production
  trust path.
- Only ingress web/API ports are public. PostgreSQL, ClamAV, worker, Prometheus
  and metrics ports stay private. Kubernetes NetworkPolicies permit only the
  required pod-to-pod and pod-to-provider flows.
- Managed PostgreSQL requires TLS verification and trusts only the staging
  Kubernetes cluster/VPC. Runtime and migration database roles are separate.
  DigitalOcean documents TLS, encryption at rest and trusted-source firewalls:
  [Managed PostgreSQL security](https://docs.digitalocean.com/products/databases/postgresql/how-to/secure/).
- The private Space has private objects, private listing and no CDN. Public
  derivatives use a different bucket and only explicitly promoted canonical
  derivatives get public-read ACLs. The web workload receives no storage key.
- Private delivery continues to require application authorization immediately
  before short-lived signing. Object keys, hashes, scanner evidence and signed
  URLs are excluded from logs and browser persistence.
- ClamAV runs as a non-root, pinned-by-digest internal workload. Only the worker
  can call it. Uploaded documents are never sent to a third-party scanning API;
  signature updates are its only required outbound path.
- GitHub protected-environment reviewers gate secret release. Credentials are
  rotated after initial E2E, on any exposure, and before any future production
  reuse. Production credentials are structurally absent from staging.
- Playwright uses deterministic synthetic identities and high-entropy canaries.
  Screenshots, traces and videos are retained briefly and scanned for forbidden
  private markers before becoming release evidence.
- Budget alerts are configured at `$90` and `$120`; the second threshold stops
  further discretionary scale-up and requires review. Provider hard limits are
  not treated as a security control.

## Exact provisioning plan

### Phase A — no billable resources

1. Approve provider, `fra1`, `$85.15/month` baseline, DNS names, billing owner
   and alert destination.
2. Add OpenTofu modules and policy checks in a pull request. Pin providers and
   container images; define exact resource names and lifecycle protections.
3. Add the separate migration credential seam, ClamAV health/readiness contract,
   scanner authentication, NetworkPolicies, resource requests/limits and
   Playwright staging configuration. Run all local and CI checks.
4. Review an expected plan and a teardown checklist. No `apply` is allowed in
   this phase.

### Phase B — billable apply after separate approval

5. Create the organization DigitalOcean Team, enforce secure sign-in, configure
   billing and budget alerts, then create the isolated `portal-staging` project.
6. Bootstrap the private encrypted IaC-state Space, create the staging VPC,
   DOKS cluster, load balancer, Managed PostgreSQL, registry and the remaining
   Spaces buckets. Record resource IDs without secret values.
7. Create least-privilege identities and rotate the bootstrap token. Store
   credentials only in the GitHub `staging` Environment and Kubernetes Secrets.
8. Restrict database trusted sources, bucket listing/ACLs, registry pull access,
   Kubernetes RBAC, Pod Security and NetworkPolicies before deploying apps.
9. Configure DNS and cert-manager, verify HTTPS redirects, certificate renewal,
   headers and that private service ports are unreachable externally.
10. Install pinned ingress, ClamAV and Prometheus components. Verify fresh
    malware signatures, scanner fail-closed behavior, bounded retention and the
    alert webhook.
11. Build immutable web/API/worker images, resolve digests, run migrations with
    the migration-only role, then deploy through the protected staging workflow.
12. Seed synthetic R3 fixtures only. Exercise image/PDF processing through the
    durable queue and verify private/public object separation and revocation.
13. Run Chromium, Firefox and WebKit staging E2E for customer/provider/
    competitor/outsider/suspended actors, UUID swaps, CSRF/session boundaries,
    Quote isolation, private redirects, replaced/revoked media and concurrent
    state transitions.
14. Store privacy-safe evidence containing release SHA, environment, browser
    versions, case counts and zero-leak/zero-partial-effect results. Only then may
    R3-022 become `DONE`.

### Rollback and teardown

- Application rollback uses the prior immutable image digests; database changes
  remain forward-only and are verified by the existing recovery procedure.
- A failed or abandoned staging evaluation destroys synthetic objects, database,
  cluster, load balancer and registry, then revokes every staging credential.
- Retain only redacted release evidence and the infrastructure state needed to
  prove teardown. Never copy staging credentials or data into production.

## Approval required before provisioning

The next human decision is limited and explicit: approve or reject DigitalOcean
`fra1`, the `$85.15/month` non-HA staging baseline, the named DNS/alert owners
and execution of Phase B. Until then, R3-022 remains locally implemented with
staging E2E unverified.
