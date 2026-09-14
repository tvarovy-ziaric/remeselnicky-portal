# Metrics, health and alerting

R0-027 adds a provider-neutral Prometheus exposition boundary. The API exposes
metrics only on container port `9464`; the worker exposes metrics and its own
minimal health endpoints on `9465`. Neither port is routed by the public
Ingress. The existing public API health responses remain detail-free.

Every series includes `service`, `environment` and `release_revision`. HTTP
labels are limited to method, a normalized route template and a bounded result
class. Database metrics cover readiness availability and probe latency. Worker
metrics cover queue depth, in-flight work, oldest-message age, processing
outcomes and loop readiness. Metric APIs accept no actor, user, request, Job or
queue-delivery identifiers; those belong only in privacy-safe structured logs.
Metrics and scrape failures are best effort and never change an HTTP, queue or
business result.

## Cluster contract

`deploy/observability/monitoring.yaml` uses the provider-neutral Prometheus
Operator CRDs `ServiceMonitor`, `PrometheusRule` and `AlertmanagerConfig`.
Staging and production clusters must install compatible CRDs and select these
resources. The alert route groups and cools down critical alerts, sends recovery
notifications, and reads the receiver URL from key `webhook-url` in the
namespace-local Secret `portal-critical-alert-channel`. The Secret is supplied
through the approved secret manager and must never be committed.

The initial alerts intentionally cover obvious availability loss, DB readiness,
queue terminal failure and sustained queue lag. Exact thresholds must be tuned
after a staging baseline. A future durable queue adapter may add a bounded queue
class so analytics failures can route below transactional-delivery failures;
user/job identifiers remain forbidden.

## Staging channel verification

Before a channel is considered tested:

1. assign the staging incident-owner role and provision its generic HTTPS
   receiver as `portal-critical-alert-channel/webhook-url`;
2. deploy the staging monitoring resources and confirm both ServiceMonitor
   targets are healthy for the components that have non-zero replicas;
3. from an approved operator environment set
   `PORTAL_CRITICAL_ALERT_WEBHOOK_URL` and run
   `node deploy/scripts/test-critical-alert-channel.mjs`;
4. record firing receipt, deduplication and a resolved notification in the
   release evidence, without copying the receiver URL into that evidence;
5. exercise one real staging rule and attach its runbook response timeline.

Selecting/provisioning the external receiver and naming a real incident owner
remain production-account decisions. Until those are completed and evidenced,
D30 observability readiness is not a production go/no-go pass.
