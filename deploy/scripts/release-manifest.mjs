import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const placeholders = Object.freeze({
  api: "registry.invalid/remeselnicky-portal/api:release-revision",
  web: "registry.invalid/remeselnicky-portal/web:release-revision",
  worker: "registry.invalid/remeselnicky-portal/worker:release-revision",
});

export function renderReleaseManifest(source, input) {
  assertRevision(input.revision);
  const requiredImages = input.requiredImages ?? Object.keys(placeholders);
  if (
    requiredImages.length === 0 ||
    requiredImages.some((service) => !(service in placeholders))
  ) {
    throw new TypeError("Required release images are missing or unsupported.");
  }
  for (const service of requiredImages) {
    if (!source.includes(placeholders[service])) {
      throw new Error(
        `Release manifest is missing the required ${service} placeholder.`,
      );
    }
  }
  let rendered = source;
  let imageCount = 0;
  for (const [service, placeholder] of Object.entries(placeholders)) {
    if (!rendered.includes(placeholder)) continue;
    const image = input.images[service];
    assertDigestImage(image, service);
    rendered = rendered.replaceAll(placeholder, image);
    imageCount += 1;
  }
  if (imageCount === 0 || !rendered.includes("release-revision")) {
    throw new Error("Release manifest contains no recognized placeholders.");
  }
  rendered = rendered.replaceAll("release-revision", input.revision);
  if (
    rendered.includes("registry.invalid") ||
    rendered.includes("release-revision") ||
    /(?:^|\n)kind:\s*Secret\s*(?:\n|$)/u.test(rendered)
  ) {
    throw new Error("Rendered release manifest is incomplete or unsafe.");
  }
  return rendered;
}

export function assertDigestImage(value, service = "image") {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._:/-]*\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    throw new TypeError(
      `${service} image must use an immutable SHA-256 digest.`,
    );
  }
}

export function assertRevision(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError("Release revision must be a full lowercase Git SHA.");
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = await readFile(options.input, "utf8");
  const rendered = renderReleaseManifest(source, {
    images: {
      api: process.env.API_IMAGE,
      web: process.env.WEB_IMAGE,
      worker: process.env.WORKER_IMAGE,
    },
    requiredImages: options.requiredImages,
    revision: process.env.RELEASE_REVISION,
  });
  await writeFile(options.output, rendered, { encoding: "utf8", flag: "wx" });
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      (name !== "--input" &&
        name !== "--output" &&
        name !== "--required-images") ||
      value === undefined
    ) {
      throw new TypeError("Usage: release-manifest --input FILE --output FILE");
    }
    result[name.slice(2)] = value;
  }
  if (typeof result.input !== "string" || typeof result.output !== "string") {
    throw new TypeError("Input and output manifest paths are required.");
  }
  if (typeof result["required-images"] !== "string") {
    throw new TypeError("Required release image list is required.");
  }
  return {
    input: result.input,
    output: result.output,
    requiredImages: result["required-images"].split(","),
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
