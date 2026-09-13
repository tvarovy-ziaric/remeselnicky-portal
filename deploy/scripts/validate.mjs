import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
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
  if (
    !ingress.includes("tls:") ||
    !ingress.includes("secretName: portal-tls")
  ) {
    failures.push(`${environment}: TLS secret path is missing`);
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
