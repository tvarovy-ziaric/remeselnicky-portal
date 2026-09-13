import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly exports?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

describe("authorization package boundary", () => {
  it("exports runtime code only under the Node condition", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;

    expect(manifest.exports?.["."]).toEqual({
      node: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(manifest.exports?.["."]).not.toHaveProperty("browser");
    expect(manifest.exports?.["."]).not.toHaveProperty("default");
    expect(manifest.exports?.["."]).not.toHaveProperty("import");
  });
});
