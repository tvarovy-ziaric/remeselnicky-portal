import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("projection package boundary", () => {
  it("exports serializers only to Node/server consumers", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly exports: Readonly<
        Record<string, Readonly<Record<string, string>>>
      >;
    };
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      node: "./dist/index.js",
    });
    expect(manifest.exports["."]).not.toHaveProperty("browser");
    expect(manifest.exports["."]).not.toHaveProperty("default");
    expect(manifest.exports["."]).not.toHaveProperty("import");
  });
});
