import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { ensureAlphaGateSession } from "./alpha-gate-session.mjs";

const root = new URL("../../../", import.meta.url);
const environment = await readFile(new URL(".env.alpha", root), "utf8");
const hostname = /^ALPHA_APP_HOSTNAME=([a-z0-9-]+\.trycloudflare\.com)$/mu.exec(
  environment,
)?.[1];
if (hostname === undefined) throw new Error("Quick app hostname is missing");
const baseURL = `https://${hostname}`;
const password = (
  await readFile(new URL(".alpha/secrets/quick_gate_password", root), "utf8")
).trim();

const stateUrls = [101, 102, 103, 104].map(
  (number) => new URL(`.alpha/r3-e2e-auth-${number}.json`, root),
);
const browser = await chromium.launch({ headless: true });
try {
  for (const stateUrl of stateUrls) {
    const statePath = fileURLToPath(stateUrl);
    try {
      await access(stateUrl);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const context = await browser.newContext({
      baseURL,
      storageState: statePath,
    });
    try {
      await ensureAlphaGateSession({ baseURL, context, password });
      await context.storageState({ path: statePath });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
process.stdout.write(
  "Synthetic browser states carry a current Alpha gate session.\n",
);
