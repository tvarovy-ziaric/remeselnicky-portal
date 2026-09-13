import { describe, expect, it, vi } from "vitest";

import {
  createBrowserErrorTracker,
  createFetchErrorTransport,
  installGlobalErrorTracking,
  type BrowserErrorSignal,
} from "../src/browser.js";

describe("privacy-safe browser error tracking", () => {
  it("emits only a bounded error class and deployment context", () => {
    const signals: BrowserErrorSignal[] = [];
    const tracker = createBrowserErrorTracker({
      createCorrelationId: () => "browser-correlation-123",
      environment: "staging",
      releaseRevision: "git-a1b2c3d4",
      transport: {
        capture(signal): void {
          signals.push(signal);
        },
      },
    });
    const error = new TypeError(
      "Person@example.com entered password super-secret in private form",
    );
    error.stack = "private stack with /request/private-description";

    tracker.capture(error, "frontend_error");

    expect(signals).toEqual([
      {
        correlationId: "browser-correlation-123",
        environment: "staging",
        errorName: "TypeError",
        mechanism: "frontend_error",
        releaseRevision: "git-a1b2c3d4",
      },
    ]);
    expect(JSON.stringify(signals)).not.toContain("Person@example.com");
    expect(JSON.stringify(signals)).not.toContain("super-secret");
    expect(signals[0]).not.toHaveProperty("message");
    expect(signals[0]).not.toHaveProperty("stack");
  });

  it("posts without credentials and ignores transport failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error("offline")),
    );
    const transport = createFetchErrorTransport({
      endpoint: "/v1/observability/frontend-errors",
      fetch,
    });
    const signal = {
      correlationId: "browser-correlation-123",
      environment: "production",
      errorName: "Error",
      mechanism: "frontend_rejection",
      releaseRevision: "git-a1b2c3d4",
    } as const;

    expect(() => transport.capture(signal)).not.toThrow();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledWith(
      "/v1/observability/frontend-errors",
      expect.objectContaining({
        credentials: "omit",
        keepalive: true,
        method: "POST",
      }),
    );
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.body).toBe(JSON.stringify(signal));
  });

  it("installs and removes only uncaught error listeners", () => {
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    const capture = vi.fn();

    const uninstall = installGlobalErrorTracking({
      target: target as Pick<
        Window,
        "addEventListener" | "removeEventListener"
      >,
      tracker: { capture },
    });
    listeners.get("error")?.({
      error: new Error("private message"),
    } as ErrorEvent);
    listeners.get("unhandledrejection")?.({
      reason: new Error("private reason"),
    } as PromiseRejectionEvent);
    uninstall();

    expect(capture).toHaveBeenNthCalledWith(
      1,
      expect.any(Error),
      "frontend_error",
    );
    expect(capture).toHaveBeenNthCalledWith(
      2,
      expect.any(Error),
      "frontend_rejection",
    );
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
  });
});
