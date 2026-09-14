import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("notifications package manifest", () => {
  it("is server-only and does not publish a browser condition", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, Record<string, string>> };
    expect(manifest.exports?.["."]).not.toHaveProperty("browser");
    expect(manifest.exports?.["."]).toHaveProperty("node");
  });
});
