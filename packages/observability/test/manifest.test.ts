import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly exports?: Readonly<
    Record<string, Readonly<Record<string, string>> | string>
  >;
}

describe("observability package boundaries", () => {
  it("keeps server logging Node-only and exposes an explicit safe browser entry", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;

    expect(manifest.exports?.["."]).toEqual({
      node: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(manifest.exports?.["./browser"]).toEqual({
      browser: "./dist/browser.js",
      default: "./dist/browser.js",
      import: "./dist/browser.js",
      types: "./dist/browser.d.ts",
    });
  });
});
