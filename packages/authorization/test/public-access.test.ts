import { describe, expect, it } from "vitest";

import {
  createPublicAccessAllowlist,
  definePublicOperation,
  type PublicOperation,
} from "../src/index.js";

describe("public operation allowlist", () => {
  it("permits only an explicitly allowlisted operation token", () => {
    const health = definePublicOperation("health.live");
    const publicProfile = definePublicOperation("profile.public-read");
    const allowlist = createPublicAccessAllowlist([health]);

    expect(allowlist.authorize(health)).toEqual({
      effect: "PERMIT",
      reason: "PUBLIC_OPERATION_ALLOWLISTED",
    });
    expect(allowlist.authorize(publicProfile)).toEqual({
      effect: "DENY",
      reason: "PUBLIC_OPERATION_NOT_ALLOWLISTED",
    });
  });

  it("denies a separately defined token even when its identifier matches", () => {
    const allowlisted = definePublicOperation("health.live");
    const unregisteredCopy = definePublicOperation("health.live");

    expect(
      createPublicAccessAllowlist([allowlisted]).authorize(unregisteredCopy),
    ).toEqual({
      effect: "DENY",
      reason: "PUBLIC_OPERATION_NOT_ALLOWLISTED",
    });
  });

  it("denies a raw client claim instead of treating a string as authority", () => {
    const health = definePublicOperation("health.live");
    const claimed = {
      identifier: "health.live",
    } as unknown as PublicOperation;

    expect(createPublicAccessAllowlist([health]).authorize(claimed)).toEqual({
      effect: "DENY",
      reason: "PUBLIC_OPERATION_NOT_ALLOWLISTED",
    });
  });

  it("rejects duplicate and unsafe operation declarations", () => {
    const first = definePublicOperation("health.live");
    const duplicate = definePublicOperation("health.live");

    expect(() => createPublicAccessAllowlist([first, duplicate])).toThrow(
      /Duplicate public operation/u,
    );
    expect(() => definePublicOperation("user@example.com")).toThrow(
      /stable lowercase identifier/u,
    );
  });
});
