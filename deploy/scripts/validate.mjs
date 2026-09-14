import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(root, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const overlays = ["development", "staging", "production"];
const failures = [];

for (const environment of overlays) {
  const manifest = read(`overlays/${environment}/kustomization.yaml`);
  const expected = environment === "development" ? "development" : environment;
  if (!manifest.includes(`APP_ENV=${expected}`)) {
    failures.push(`${environment}: APP_ENV is not isolated`);
  }
  if (!manifest.includes(`namespace: portal-${environment}`)) {
    failures.push(`${environment}: namespace is not isolated`);
  }
}

for (const environment of ["staging", "production"]) {
  const ingress = read(`overlays/${environment}/ingress.yaml`);
  const kustomization = read(`overlays/${environment}/kustomization.yaml`);
  if (
    !ingress.includes("tls:") ||
    !ingress.includes("secretName: portal-tls")
  ) {
    failures.push(`${environment}: TLS secret path is missing`);
  }
  if (!kustomization.includes("../../observability/monitoring.yaml")) {
    failures.push(
      `${environment}: operational monitoring resources are missing`,
    );
  }
}

const monitoring = read("observability/monitoring.yaml");
for (const required of [
  "kind: ServiceMonitor",
  "kind: PrometheusRule",
  "kind: AlertmanagerConfig",
  "severity: critical",
  "name: portal-critical-alert-channel",
  "key: webhook-url",
  "sendResolved: true",
  "docs/runbooks/api-or-database-unavailable.md",
  "docs/runbooks/queue-terminal-failure.md",
]) {
  if (!monitoring.includes(required)) {
    failures.push(`observability: missing ${required}`);
  }
}

const migrationJob = read("release/migration-job.yaml");
for (const required of [
  "kind: Job",
  "portal-migrate-release-revision",
  "registry.invalid/remeselnicky-portal/api:release-revision",
  'command: ["node", "packages/db/dist/migrate-cli.js"]',
  "automountServiceAccountToken: false",
  "readOnlyRootFilesystem: true",
  "ttlSecondsAfterFinished: 86400",
]) {
  if (!migrationJob.includes(required)) {
    failures.push(`release migration: missing ${required}`);
  }
}

const workflowsRoot = resolve(root, "..", ".github", "workflows");
const stagingWorkflow = readFileSync(
  resolve(workflowsRoot, "deploy-staging.yml"),
  "utf8",
);
const productionWorkflow = readFileSync(
  resolve(workflowsRoot, "deploy-production.yml"),
  "utf8",
);
for (const [environment, workflow] of [
  ["staging", stagingWorkflow],
  ["production", productionWorkflow],
]) {
  for (const required of [
    `environment: ${environment}`,
    "docker buildx imagetools inspect",
    "release-manifest.mjs",
    "migration-job.yaml",
    "smoke-release.mjs",
    "portal-migrate-$RELEASE_REVISION",
  ]) {
    if (!workflow.includes(required)) {
      failures.push(`${environment} workflow: missing ${required}`);
    }
  }
  if (workflow.includes("pull_request_target")) {
    failures.push(`${environment} workflow: pull_request_target is forbidden`);
  }
}
for (const required of [
  "workflow_dispatch:",
  "D30 PRODUCTION GO",
  "release_evidence:",
  "git merge-base --is-ancestor",
  "cancel-in-progress: false",
]) {
  if (!productionWorkflow.includes(required)) {
    failures.push(`production workflow: missing ${required}`);
  }
}
for (const forbidden of ["workflow_run:", "pull_request:", "push:"]) {
  if (productionWorkflow.includes(forbidden)) {
    failures.push(
      `production workflow: automatic trigger ${forbidden} forbidden`,
    );
  }
}
for (const workflow of [stagingWorkflow, productionWorkflow]) {
  const actionReferences = [...workflow.matchAll(/uses:\s*([^\s#]+)/gu)].map(
    (match) => match[1],
  );
  if (
    actionReferences.some(
      (reference) =>
        reference === undefined || !/@[0-9a-f]{40}$/u.test(reference),
    )
  ) {
    failures.push("release workflows must pin every action to a full SHA");
  }
}

const workspacePackages = readdirSync(resolve(repositoryRoot, "packages"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .filter((entry) => {
    try {
      readFileSync(
        resolve(repositoryRoot, "packages", entry.name, "package.json"),
        "utf8",
      );
      return true;
    } catch {
      return false;
    }
  })
  .map((entry) => entry.name);
for (const application of ["api", "web", "worker"]) {
  const dockerfile = readFileSync(
    resolve(repositoryRoot, "apps", application, "Dockerfile"),
    "utf8",
  );
  for (const packageName of workspacePackages) {
    const copy = `COPY packages/${packageName}/package.json packages/${packageName}/package.json`;
    if (!dockerfile.includes(copy)) {
      failures.push(`${application} Dockerfile: missing ${copy}`);
    }
  }
}

for (const forbiddenLabel of ["user_id", "userId", "job_id", "jobId"]) {
  if (monitoring.includes(forbiddenLabel)) {
    failures.push(
      `observability: high-cardinality label ${forbiddenLabel} is forbidden`,
    );
  }
}

const allDeploymentSources = [
  "base/api.yaml",
  "base/web.yaml",
  "base/worker.yaml",
]
  .map(read)
  .join("\n");
for (const required of [
  "release-revision",
  "readOnlyRootFilesystem: true",
  'drop: ["ALL"]',
  "automountServiceAccountToken: false",
]) {
  const source =
    required === "automountServiceAccountToken: false"
      ? read("base/service-accounts.yaml")
      : allDeploymentSources;
  if (!source.includes(required)) failures.push(`base: missing ${required}`);
}

if (allDeploymentSources.includes("kind: Secret")) {
  failures.push("deploy manifests must not materialize credentials");
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Deployment skeleton static validation passed.\n");
}
