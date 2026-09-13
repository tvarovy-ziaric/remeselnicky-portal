"use client";

import {
  createBrowserErrorTracker,
  createFetchErrorTransport,
  installGlobalErrorTracking,
} from "@portal/observability/browser";
import { useEffect, type ReactNode } from "react";

import { frontendTelemetryContext } from "./telemetry-context";

const tracker = createBrowserErrorTracker({
  ...frontendTelemetryContext,
  transport: createFetchErrorTransport({
    endpoint: "/v1/observability/frontend-errors",
  }),
});

export function FrontendErrorTracking({
  children,
}: {
  readonly children: ReactNode;
}) {
  useEffect(() => installGlobalErrorTracking({ target: window, tracker }), []);
  return children;
}

export function captureFrontendRenderError(error: unknown): void {
  tracker.capture(error, "frontend_render");
}
