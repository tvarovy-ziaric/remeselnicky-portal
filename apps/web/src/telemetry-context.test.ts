import { describe, expect, it } from "vitest";

import { frontendTelemetryContext } from "./telemetry-context";

describe("frontend error telemetry context", () => {
  it("contains only public environment and release values", () => {
    expect(["development", "staging", "production"]).toContain(
      frontendTelemetryContext.environment,
    );
    expect(frontendTelemetryContext.releaseRevision.length).toBeGreaterThan(0);
    expect(frontendTelemetryContext).not.toHaveProperty("databaseUrl");
    expect(frontendTelemetryContext).not.toHaveProperty("sessionSecret");
  });
});
