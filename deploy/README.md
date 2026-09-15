# Provider-portable deployment skeleton

The three Kustomize overlays isolate development, staging, and production in
separate namespaces and configuration. They deliberately select no cloud,
registry, ingress, certificate, database, or secret-management vendor.

## Required platform contracts

- Supply `portal-runtime-secrets` independently in each namespace with
  `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `SESSION_SECRET`,
  `OBJECT_STORAGE_ACCESS_KEY_ID` and `OBJECT_STORAGE_SECRET_ACCESS_KEY`. Never
  commit rendered Secrets. Runtime database credentials must be least-privilege,
  unable to perform schema migrations and different per environment. The
  release migration Job maps the separate schema-owner
  `MIGRATION_DATABASE_URL` to the migration CLI's process-local `DATABASE_URL`.
  Both database URLs must enable verified TLS outside development.
- Replace the object-storage endpoint, public media origin, provider region and
  container placeholders independently in staging and production. The private
  and public-derivative containers must be distinct, credentials must be scoped
  to only the configured containers, and both service origins must use HTTPS.
- Supply `portal-tls` in staging and production. Configure the cluster's
  default Ingress class to redirect or reject plaintext HTTP. Replace the
  reserved `.invalid` hosts with environment-specific DNS names before use.
- Staging and production clusters must provide Prometheus Operator-compatible
  `ServiceMonitor`, `PrometheusRule` and `AlertmanagerConfig` CRDs. Supply the
  namespace-local Secret `portal-critical-alert-channel` with key `webhook-url`
  through the approved secret manager; the value must not enter Git or rendered
  release evidence.
- Grant the staging and production GitHub environments separate,
  namespace-scoped Kubernetes identities. The staging identity must have no
  production access; the production identity is released only after a required
  environment review.
- Treat `release-revision` and `registry.invalid/remeselnicky-portal` as render
  placeholders. Release workflows resolve pushed images to immutable SHA-256
  digests. OCI revision labels, runtime config and deployment annotations must
  all receive the same full Git revision.
- Build the web image with `DEPLOYMENT_ENV=development|staging|production` for
  its target overlay because `NEXT_PUBLIC_*` values are embedded at build time.
  The staging workflow supplies `staging`; a production go/no-go build must
  explicitly supply `production`.

The worker runs one replica against the PostgreSQL transactional outbox. It
creates canonical in-app records and queued email deliveries; an approved email
provider adapter and its credentials remain a separate production gate. Scrape
and health traffic uses service port `9465`. API metrics use internal service
port `9464`. Neither monitoring port is exposed by Ingress.

## Staging CI contract

The staging workflow is manual-only. Dispatch it with the exact full Git SHA
already reachable from `main` and the literal confirmation `STAGING DEPLOY`.
The protected `staging` environment may additionally require an environment
review before releasing credentials. An ordinary push or successful CI run
cannot apply manifests or instantiate the ingress load balancer. Configure the
environment with:

- variable `STAGING_IMAGE_PREFIX` (for example an OCI repository prefix);
- secrets `REGISTRY_HOST`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`;
- secret `KUBE_CONFIG_STAGING_B64`, containing a base64 kubeconfig for the
  namespace-scoped deployment identity.

The workflow builds and pushes revision-tagged OCI images, resolves their
registry digests, renders staging, runs the migration Job, waits for rollouts,
and checks public web, auth, database readiness and release metrics through
authenticated Kubernetes port forwarding.

## Production protection

The production workflow is manual-only and bound to the protected `production`
environment. Configure variable `PRODUCTION_IMAGE_PREFIX` plus environment-only
secrets `REGISTRY_HOST`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` and
`KUBE_CONFIG_PRODUCTION_B64`. Required reviewers must verify the D30 evidence
reference and explicit go/no-go before secrets are released. Production
credentials must not be present in the staging GitHub environment. See
`docs/release/release-and-rollback.md` for the approval and rollback procedure.

Run static validation with:

```bash
node deploy/scripts/validate.mjs
kubectl kustomize deploy/overlays/development >/dev/null
kubectl kustomize deploy/overlays/staging >/dev/null
kubectl kustomize deploy/overlays/production >/dev/null
```
