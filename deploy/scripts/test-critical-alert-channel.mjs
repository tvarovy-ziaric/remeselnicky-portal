#!/usr/bin/env node

const endpoint = process.env.PORTAL_CRITICAL_ALERT_WEBHOOK_URL;
if (endpoint === undefined) {
  throw new Error("PORTAL_CRITICAL_ALERT_WEBHOOK_URL is required");
}

const url = new URL(endpoint);
if (
  url.protocol !== "https:" &&
  !(
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname)
  )
) {
  throw new Error("The alert test endpoint must use HTTPS or local HTTP");
}

const response = await fetch(url, {
  body: JSON.stringify({
    alerts: [
      {
        annotations: {
          runbook: "docs/runbooks/api-or-database-unavailable.md",
          summary: "Staging critical channel verification",
        },
        endsAt: "0001-01-01T00:00:00Z",
        labels: {
          alertname: "PortalStagingCriticalChannelTest",
          environment: "staging",
          severity: "critical",
          service: "operational-test",
        },
        startsAt: new Date().toISOString(),
        status: "firing",
      },
    ],
    commonLabels: {
      alertname: "PortalStagingCriticalChannelTest",
      environment: "staging",
      severity: "critical",
    },
    receiver: "portal-critical-webhook",
    status: "firing",
    version: "4",
  }),
  headers: { "content-type": "application/json" },
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});

if (!response.ok) {
  throw new Error(
    `Critical alert channel rejected the test (${response.status})`,
  );
}
process.stdout.write(
  "Critical staging alert test was accepted. Verify receipt and resolution with the incident owner.\n",
);
