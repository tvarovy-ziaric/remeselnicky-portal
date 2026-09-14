# Release and rollback baseline

This baseline implements R0-033 and the mechanical part of D30. It does not
authorize a real-user launch. Creating the production GitHub environment,
supplying production credentials and approving its protected deployment remain
explicit human gates.

## Release candidate to staging

After successful `CI` on `main`, `deploy-staging.yml` checks out that exact
40-character revision. It builds environment-specific web/API/worker images,
pushes revision tags, resolves the registry-reported SHA-256 digests and renders
only digest-pinned workloads. The deployment runs the versioned migration Job
before application rollout.

The post-rollout smoke script proves all of the following without credentials or
personal data:

- the public web root returns HTTP 200;
- API liveness is healthy;
- API readiness reports the database as available;
- the public CSRF endpoint proves that the authentication module is mounted and
  returns a non-cacheable challenge;
- internal metrics expose the exact expected release revision.

Configure the protected `staging` environment as described in `deploy/README.md`.
The workflow itself creates no vendor account, cluster, DNS, registry or secret.

## Production go/no-go

`deploy-production.yml` has only a manual `workflow_dispatch` trigger. Configure
the `production` GitHub environment with required reviewers, prevent self-review
where supported, restrict allowed branches to `main`, and keep production
registry/Kubernetes credentials scoped only to that environment.

The reviewer must verify the referenced immutable D30 evidence bundle before
approving. The dispatch requires:

1. a full revision which is an ancestor of `origin/main`;
2. a stable evidence reference reviewed by the approver;
3. the exact statement `D30 PRODUCTION GO`.

The workflow still fails closed if any input, secret, migration, rollout, smoke
or release-revision check fails. Text input alone is not approval; the protected
environment review is the authoritative human gate.

## Rollback baseline

Before mutating deployments, each workflow writes the current deployment names,
release annotations and immutable image digests to its durable job summary. Save
that summary in the incident record. Never use `latest`, a mutable tag or an
unreviewed image as a rollback target.

For an application-only regression:

1. stop further deployments and open an incident record;
2. identify the last healthy revision and three image digests from the preceding
   successful deployment summary and registry provenance;
3. verify the database migrations applied by the failed release are backward
   compatible with the previous application revision;
4. check out the last healthy revision, render its environment overlay with
   `release-manifest.mjs` using those exact digests, and review the manifest;
5. apply with the environment's least-privilege deployment identity, wait for
   API/web rollout and run `smoke-release.mjs` against the restored revision;
6. record operator, incident, failed/restored revisions, digests and smoke result.

Do not run an ad-hoc down migration. Migrations are roll-forward by default. If
backward compatibility is not proven, disable/contain the affected feature and
ship a reviewed forward fix. Restoring production data is a separate destructive
recovery action governed by the backup/restore runbook and explicit authority.

For an initial deployment with no prior application digest, there is no code
rollback target; use containment and a forward fix. This limitation must be
explicit in the first-launch go/no-go evidence.
