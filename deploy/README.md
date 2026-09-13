# Provider-portable deployment skeleton

The three Kustomize overlays isolate development, staging, and production in
separate namespaces and configuration. They deliberately select no cloud,
registry, ingress, certificate, database, or secret-management vendor.

## Required platform contracts

- Supply `portal-runtime-secrets` independently in each namespace with
  `DATABASE_URL` and `SESSION_SECRET`. Never commit rendered Secrets. Runtime
  database credentials must be least-privilege and different per environment;
  production `DATABASE_URL` must enable TLS.
- Supply `portal-tls` in staging and production. Configure the cluster's
  default Ingress class to redirect or reject plaintext HTTP. Replace the
  reserved `.invalid` hosts with environment-specific DNS names before use.
- Grant CI's staging Kubernetes identity namespace-scoped deployment rights
  only. It does not need production access.
- Treat `release-revision` and `registry.invalid/remeselnicky-portal` as render
  placeholders. Every image tag, OCI revision label, runtime config value, and
  deployment annotation must receive the same immutable Git revision.
- Build the web image with `DEPLOYMENT_ENV=development|staging|production` for
  its target overlay because `NEXT_PUBLIC_*` values are embedded at build time.
  The staging workflow supplies `staging`; a production go/no-go build must
  explicitly supply `production`.

The worker is intentionally at zero replicas until its durable queue run loop
exists; the current bootstrap worker exits after one status record.

## Staging CI contract

The staging workflow runs only after successful main-branch CI or explicit
dispatch. Configure the protected `staging` GitHub environment with:

- variable `STAGING_IMAGE_PREFIX` (for example an OCI repository prefix);
- secrets `REGISTRY_HOST`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`;
- secret `KUBE_CONFIG_STAGING_B64`, containing a base64 kubeconfig for the
  namespace-scoped deployment identity.

The workflow builds and pushes revision-tagged OCI images, renders staging,
checks that placeholders are gone, deploys, waits for rollouts, and runs web/API
smoke checks through authenticated Kubernetes port forwarding.

## Production protection

There is no CI production deployment path. Production requires an explicit
D30 human go/no-go after required test, security/privacy, backup/restore, and
observability gates pass. At that point render the production overlay with the
approved immutable images/revision, review the manifest, and apply it using a
separate least-privilege production identity. Production credentials must not
be present in the staging GitHub environment.

Run static validation with:

```bash
node deploy/scripts/validate.mjs
kubectl kustomize deploy/overlays/development >/dev/null
kubectl kustomize deploy/overlays/staging >/dev/null
kubectl kustomize deploy/overlays/production >/dev/null
```
