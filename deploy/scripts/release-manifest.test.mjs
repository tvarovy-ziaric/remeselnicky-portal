import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDigestImage,
  renderReleaseManifest,
} from "./release-manifest.mjs";

const revision = "a".repeat(40);
const digest = (service, character) =>
  `registry.example.test/portal/${service}@sha256:${character.repeat(64)}`;

test("renders every workload to a digest and injects the exact revision", () => {
  const source = `
image: registry.invalid/remeselnicky-portal/web:release-revision
image: registry.invalid/remeselnicky-portal/api:release-revision
image: registry.invalid/remeselnicky-portal/worker:release-revision
annotation: release-revision
`;
  const rendered = renderReleaseManifest(source, {
    images: {
      api: digest("api", "b"),
      web: digest("web", "c"),
      worker: digest("worker", "d"),
    },
    requiredImages: ["web", "api", "worker"],
    revision,
  });
  assert.match(rendered, /web@sha256:c{64}/u);
  assert.match(rendered, new RegExp(revision, "u"));
  assert.doesNotMatch(rendered, /release-revision|registry\.invalid/u);
});

test("rejects tags, credentials and a Secret manifest", () => {
  assert.throws(() => assertDigestImage("registry.test/api:latest"), /digest/u);
  assert.throws(
    () =>
      assertDigestImage(
        `synthetic-user:synthetic-value@registry.test/portal/api@sha256:${"a".repeat(64)}`,
      ),
    /digest/u,
  );
  assert.throws(
    () =>
      renderReleaseManifest(
        `kind: Secret\nimage: registry.invalid/remeselnicky-portal/api:release-revision\nannotation: release-revision`,
        {
          images: { api: digest("api", "b") },
          requiredImages: ["api"],
          revision,
        },
      ),
    /unsafe/u,
  );
});

test("requires the full lowercase commit revision", () => {
  assert.throws(
    () =>
      renderReleaseManifest(
        "image: registry.invalid/remeselnicky-portal/api:release-revision",
        {
          images: { api: digest("api", "b") },
          requiredImages: ["api"],
          revision: "abc123",
        },
      ),
    /full lowercase Git SHA/u,
  );
});

test("fails when a required workload placeholder is absent", () => {
  assert.throws(
    () =>
      renderReleaseManifest(
        `image: registry.invalid/remeselnicky-portal/web:release-revision\nimage: registry.invalid/remeselnicky-portal/api:release-revision\nannotation: release-revision`,
        {
          images: {
            api: digest("api", "b"),
            web: digest("web", "c"),
            worker: digest("worker", "d"),
          },
          requiredImages: ["web", "api", "worker"],
          revision,
        },
      ),
    /missing the required worker placeholder/u,
  );
});
