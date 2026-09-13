import { parsePublicConfig } from "@portal/config/public";

export const frontendTelemetryContext = parsePublicConfig({
  NEXT_PUBLIC_APP_ENV:
    process.env.NEXT_PUBLIC_APP_ENV === "production" ||
    process.env.NEXT_PUBLIC_APP_ENV === "staging"
      ? process.env.NEXT_PUBLIC_APP_ENV
      : "development",
  NEXT_PUBLIC_RELEASE_REVISION:
    process.env.NEXT_PUBLIC_RELEASE_REVISION ?? "local-development",
});
