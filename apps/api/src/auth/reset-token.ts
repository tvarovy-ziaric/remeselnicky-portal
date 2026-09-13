import { createHash, randomBytes } from "node:crypto";

import type { ResetTokenService } from "./types.js";

export function createResetTokenService(): ResetTokenService {
  return Object.freeze({
    digest(token: string): string {
      return createHash("sha256").update(token, "utf8").digest("hex");
    },
    generate(): string {
      return randomBytes(32).toString("base64url");
    },
  });
}
