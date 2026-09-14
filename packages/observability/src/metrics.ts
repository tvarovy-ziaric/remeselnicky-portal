import type { ServiceTelemetryContext } from "./types.js";

const HTTP_DURATION_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000,
] as const;
const DATABASE_DURATION_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500,
] as const;
const MAX_ROUTE_SERIES = 128;

type HttpResult =
  | "authentication_failed"
  | "authorization_denied"
  | "client_error"
  | "rate_limited"
  | "redirect"
  | "server_error"
  | "success";

export type QueueMetricEvent =
  | "job_attempt_started"
  | "job_attempt_succeeded"
  | "job_retry_scheduled"
  | "job_terminal_failure";

export interface QueueMetricSnapshot {
  readonly depth: number;
  readonly inFlight: number;
  readonly oldestInFlightAgeMs: number | undefined;
  readonly oldestPendingAgeMs: number | undefined;
}

export interface PortalMetrics {
  readonly contentType: "text/plain; version=0.0.4; charset=utf-8";
  recordDatabaseProbe(input: {
    readonly durationMs: number;
    readonly result: "available" | "unavailable";
  }): void;
  recordHttp(input: {
    readonly durationMs: number;
    readonly method: string;
    readonly route: string | undefined;
    readonly statusCode: number;
  }): void;
  recordQueueEvent(event: QueueMetricEvent): void;
  render(): string;
  setQueueSnapshot(snapshot: QueueMetricSnapshot): void;
  setWorkerReady(ready: boolean): void;
}

interface Series {
  readonly labels: Readonly<Record<string, string>>;
  value: number;
}

interface HistogramSeries {
  readonly buckets: number[];
  count: number;
  readonly labels: Readonly<Record<string, string>>;
  sum: number;
}

/**
 * A deliberately small provider-neutral metrics registry. Its public methods
 * accept only bounded operational dimensions, so domain identifiers cannot
 * accidentally become metric labels.
 */
export function createPortalMetrics(
  context: ServiceTelemetryContext,
): PortalMetrics {
  const staticLabels = Object.freeze({
    environment: context.environment,
    release_revision: boundedContextLabel(context.releaseRevision, "unknown"),
    service: boundedContextLabel(context.service, "unknown"),
  });
  const knownRoutes = new Set<string>();
  const counters = new Map<string, Series>();
  const gauges = new Map<string, Series>();
  const histograms = new Map<string, HistogramSeries>();

  function labels(extra: Readonly<Record<string, string>>) {
    return Object.freeze({ ...staticLabels, ...extra });
  }

  function addCounter(
    name: string,
    labelValues: Readonly<Record<string, string>>,
    increment = 1,
  ): void {
    const key = seriesKey(name, labelValues);
    const existing = counters.get(key);
    if (existing === undefined) {
      counters.set(key, { labels: labelValues, value: increment });
      return;
    }
    existing.value += increment;
  }

  function setGauge(
    name: string,
    labelValues: Readonly<Record<string, string>>,
    value: number,
  ): void {
    gauges.set(seriesKey(name, labelValues), {
      labels: labelValues,
      value: finiteNonNegative(value),
    });
  }

  function observeHistogram(
    name: string,
    labelValues: Readonly<Record<string, string>>,
    value: number,
    boundaries: readonly number[],
  ): void {
    const observation = finiteNonNegative(value);
    const key = seriesKey(name, labelValues);
    const existing = histograms.get(key);
    if (existing === undefined) {
      histograms.set(key, {
        buckets: boundaries.map((boundary) =>
          observation <= boundary ? 1 : 0,
        ),
        count: 1,
        labels: labelValues,
        sum: observation,
      });
      return;
    }
    existing.count += 1;
    existing.sum += observation;
    boundaries.forEach((boundary, index) => {
      if (observation <= boundary) {
        existing.buckets[index] = (existing.buckets[index] ?? 0) + 1;
      }
    });
  }

  const metrics: PortalMetrics = {
    contentType: "text/plain; version=0.0.4; charset=utf-8",
    recordDatabaseProbe(input): void {
      const probeLabels = labels({ result: input.result });
      addCounter("portal_database_probes_total", probeLabels);
      observeHistogram(
        "portal_database_probe_duration_milliseconds",
        probeLabels,
        input.durationMs,
        DATABASE_DURATION_BUCKETS_MS,
      );
      setGauge(
        "portal_database_available",
        labels({}),
        input.result === "available" ? 1 : 0,
      );
    },
    recordHttp(input): void {
      const route = metricRoute(input.route, knownRoutes);
      const requestLabels = labels({
        method: metricMethod(input.method),
        result: httpResult(input.statusCode),
        route,
      });
      addCounter("portal_http_requests_total", requestLabels);
      observeHistogram(
        "portal_http_request_duration_milliseconds",
        requestLabels,
        input.durationMs,
        HTTP_DURATION_BUCKETS_MS,
      );
    },
    recordQueueEvent(event): void {
      const outcome =
        event === "job_attempt_started"
          ? "attempted"
          : event === "job_attempt_succeeded"
            ? "succeeded"
            : event === "job_retry_scheduled"
              ? "retry_scheduled"
              : "terminal_failure";
      addCounter("portal_queue_jobs_total", labels({ outcome }));
    },
    render(): string {
      const lines: string[] = [];
      appendMetric(lines, {
        help: "HTTP requests completed by bounded route and outcome.",
        name: "portal_http_requests_total",
        series: counters,
        type: "counter",
      });
      appendHistogram(lines, {
        boundaries: HTTP_DURATION_BUCKETS_MS,
        help: "HTTP request duration in milliseconds.",
        name: "portal_http_request_duration_milliseconds",
        series: histograms,
      });
      appendMetric(lines, {
        help: "Database health probes by result.",
        name: "portal_database_probes_total",
        series: counters,
        type: "counter",
      });
      appendHistogram(lines, {
        boundaries: DATABASE_DURATION_BUCKETS_MS,
        help: "Database health probe duration in milliseconds.",
        name: "portal_database_probe_duration_milliseconds",
        series: histograms,
      });
      for (const definition of [
        [
          "portal_database_available",
          "Database readiness, where 1 is available.",
        ],
        ["portal_queue_depth", "Pending queue deliveries."],
        ["portal_queue_in_flight", "Queue deliveries currently in flight."],
        [
          "portal_queue_oldest_pending_age_seconds",
          "Age of the oldest pending queue delivery in seconds.",
        ],
        [
          "portal_queue_oldest_in_flight_age_seconds",
          "Age of the oldest in-flight queue delivery in seconds.",
        ],
        ["portal_worker_ready", "Worker loop readiness, where 1 is ready."],
      ] as const) {
        appendMetric(lines, {
          help: definition[1],
          name: definition[0],
          series: gauges,
          type: "gauge",
        });
      }
      appendMetric(lines, {
        help: "Queue processing outcomes without job or user identifiers.",
        name: "portal_queue_jobs_total",
        series: counters,
        type: "counter",
      });
      return `${lines.join("\n")}\n`;
    },
    setQueueSnapshot(snapshot): void {
      const queueLabels = labels({ queue: "default" });
      setGauge("portal_queue_depth", queueLabels, snapshot.depth);
      setGauge("portal_queue_in_flight", queueLabels, snapshot.inFlight);
      setGauge(
        "portal_queue_oldest_pending_age_seconds",
        queueLabels,
        millisecondsToSeconds(snapshot.oldestPendingAgeMs),
      );
      setGauge(
        "portal_queue_oldest_in_flight_age_seconds",
        queueLabels,
        millisecondsToSeconds(snapshot.oldestInFlightAgeMs),
      );
    },
    setWorkerReady(ready): void {
      setGauge("portal_worker_ready", labels({}), ready ? 1 : 0);
    },
  };

  return Object.freeze(metrics);
}

function metricMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].includes(
    normalized,
  )
    ? normalized
    : "OTHER";
}

function boundedContextLabel(value: string, fallback: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(value) ? value : fallback;
}

function metricRoute(route: string | undefined, known: Set<string>): string {
  if (route === undefined || route === "" || route.length > 160)
    return "unmatched";
  const withoutQuery = route.split("?", 1)[0] ?? "unmatched";
  const normalized = withoutQuery
    .split("/")
    .map((segment) =>
      /^\d+$/u.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment) ||
      /^[A-Za-z0-9_-]{24,}$/u.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
  if (!normalized.startsWith("/") || /[\r\n]/u.test(normalized)) {
    return "unmatched";
  }
  if (known.has(normalized)) return normalized;
  if (known.size >= MAX_ROUTE_SERIES) return "other";
  known.add(normalized);
  return normalized;
}

function httpResult(statusCode: number): HttpResult {
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 401) return "authentication_failed";
  if (statusCode === 403) return "authorization_denied";
  if (statusCode >= 500) return "server_error";
  if (statusCode >= 400) return "client_error";
  if (statusCode >= 300) return "redirect";
  return "success";
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function millisecondsToSeconds(value: number | undefined): number {
  return value === undefined ? 0 : finiteNonNegative(value) / 1_000;
}

function seriesKey(
  name: string,
  labels: Readonly<Record<string, string>>,
): string {
  return `${name}\u0000${Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\u0000")}`;
}

function appendMetric(
  lines: string[],
  definition: {
    readonly help: string;
    readonly name: string;
    readonly series: ReadonlyMap<string, Series>;
    readonly type: "counter" | "gauge";
  },
): void {
  const matching = [...definition.series.entries()]
    .filter(([key]) => key.startsWith(`${definition.name}\u0000`))
    .sort(([left], [right]) => left.localeCompare(right));
  if (matching.length === 0) return;
  lines.push(`# HELP ${definition.name} ${definition.help}`);
  lines.push(`# TYPE ${definition.name} ${definition.type}`);
  for (const [, series] of matching) {
    lines.push(
      `${definition.name}${renderLabels(series.labels)} ${series.value}`,
    );
  }
}

function appendHistogram(
  lines: string[],
  definition: {
    readonly boundaries: readonly number[];
    readonly help: string;
    readonly name: string;
    readonly series: ReadonlyMap<string, HistogramSeries>;
  },
): void {
  const matching = [...definition.series.entries()]
    .filter(([key]) => key.startsWith(`${definition.name}\u0000`))
    .sort(([left], [right]) => left.localeCompare(right));
  if (matching.length === 0) return;
  lines.push(`# HELP ${definition.name} ${definition.help}`);
  lines.push(`# TYPE ${definition.name} histogram`);
  for (const [, series] of matching) {
    definition.boundaries.forEach((boundary, index) => {
      lines.push(
        `${definition.name}_bucket${renderLabels({ ...series.labels, le: String(boundary) })} ${series.buckets[index] ?? 0}`,
      );
    });
    lines.push(
      `${definition.name}_bucket${renderLabels({ ...series.labels, le: "+Inf" })} ${series.count}`,
    );
    lines.push(
      `${definition.name}_sum${renderLabels(series.labels)} ${series.sum}`,
    );
    lines.push(
      `${definition.name}_count${renderLabels(series.labels)} ${series.count}`,
    );
  }
}

function renderLabels(labels: Readonly<Record<string, string>>): string {
  const values = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  return values.length === 0 ? "" : `{${values.join(",")}}`;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}
