# Staging OpenTofu root

This root describes only the approved, isolated DigitalOcean staging substrate.
It does not create a Team, billing method, DNS record, alert receiver, Spaces
access key, Kubernetes Secret or any production trust path. Running `apply`
remains forbidden until the separate Phase B approval in
`docs/release/staging-provider-plan.md`.

## Inputs and credential boundary

- `DIGITALOCEAN_TOKEN`: short-lived infrastructure token, supplied through the
  protected provisioning environment and never written to a tfvars file.
- `SPACES_ACCESS_KEY_ID` / `SPACES_SECRET_ACCESS_KEY`: bootstrap key needed by
  the provider for bucket operations.
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`: separate state-only key for the
  S3-compatible backend.
- `kubernetes_version`: exact supported DOKS version; `latest` is rejected.
- `name_suffix`: allocated once and retained in the protected environment.

The encrypted private state bucket is bootstrapped manually after approval,
before this root is initialized. Backend credentials are environment variables;
they must not be passed on the command line or committed in `backend.hcl`.

## Non-mutating review

After copying only the two example files outside version control:

```text
tofu init -backend=false
tofu fmt -check -recursive
tofu validate
tofu plan -refresh=false -out=staging.tfplan
tofu show staging.tfplan
```

The final provider-backed plan replaces `-backend=false` with
`-backend-config=backend.hcl`. Review must confirm exactly one 8 GiB DOKS node,
one Basic registry, one 1 GiB PostgreSQL node, two application Spaces buckets,
the dedicated VPC/firewall and no destroy actions. The ingress controller later
creates the single priced load balancer. Application/RBAC/NetworkPolicy
installation is a separate post-cluster step so Kubernetes credentials are not
coupled to cluster creation.

Database role passwords are not outputs. The managed primary credential is used
once, through a controlled bootstrap job, to create distinct schema-owner and
runtime roles; only their TLS-verified URLs enter the corresponding Kubernetes
Secrets. No plan file or state output may be attached to CI artifacts.
