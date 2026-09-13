import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("commands package boundary", () => {
  it("exports runtime code only to Node consumers", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly exports?: Readonly<Record<string, unknown>> };

    expect(manifest.exports?.["."]).toEqual({
      node: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
  });
});
