import type {
  AnalyticsEnvelope,
  AnalyticsEnvironment,
  AnalyticsTransport,
} from "./types.js";

export function createNoopAnalyticsTransport(
  environment: AnalyticsEnvironment,
): AnalyticsTransport {
  return Object.freeze({
    deliver(): Promise<void> {
      // Deliberately disabled. createAnalytics reports TRANSPORT_DISABLED.
      return Promise.resolve();
    },
    environment,
    kind: "NOOP" as const,
  });
}

export interface MemoryAnalyticsTransport extends AnalyticsTransport {
  readonly kind: "TEST";
  events(): readonly AnalyticsEnvelope[];
}

export function createMemoryAnalyticsTransport(
  environment: Exclude<AnalyticsEnvironment, "production">,
): MemoryAnalyticsTransport {
  const delivered: AnalyticsEnvelope[] = [];
  return Object.freeze({
    deliver(event: AnalyticsEnvelope): Promise<void> {
      delivered.push(event);
      return Promise.resolve();
    },
    environment,
    events(): readonly AnalyticsEnvelope[] {
      return Object.freeze([...delivered]);
    },
    kind: "TEST" as const,
  });
}
