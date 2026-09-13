import * as argon2 from "argon2";

import type { PasswordHasher } from "./types.js";

export function createArgon2PasswordHasher(): PasswordHasher {
  return Object.freeze({
    hash(password: string): Promise<string> {
      return argon2.hash(password, { type: argon2.argon2id });
    },
    async verify(hash: string, password: string): Promise<boolean> {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    },
  });
}
