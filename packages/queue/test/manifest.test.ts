import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly exports?: Readonly<
    Record<string, Readonly<Record<string, string>> | string>
  >;
}

describe("queue package boundary", () => {
  it("exports runtime code only to Node consumers", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;
    const rootExport = manifest.exports?.["."];

    expect(rootExport).toEqual({
      node: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(rootExport).not.toHaveProperty("browser");
    expect(rootExport).not.toHaveProperty("default");
    expect(rootExport).not.toHaveProperty("import");
  });
});
