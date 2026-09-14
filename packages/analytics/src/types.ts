import type {
  AnalyticsEventName,
  AnalyticsPropertiesByName,
} from "./catalog.js";

export type AnalyticsEnvironment = "development" | "staging" | "production";
export type AnalyticsPlatform = "WEB" | "IOS" | "ANDROID";
export type AnalyticsProfileContext = "CUSTOMER" | "CRAFTSMAN" | "BOTH";

export interface AnalyticsActorContext {
  readonly kind: "ACTOR";
  /** Internal pseudonymous User ID. Never an email, phone, or vendor identity. */
  readonly user_id: string;
  readonly profile_context: AnalyticsProfileContext;
  /** Allows internal/test traffic to be excluded from production KPIs. */
  readonly is_internal: boolean;
  readonly is_test: boolean;
}

export interface AnalyticsAnonymousContext {
  readonly kind: "ANONYMOUS";
  /** Random first-party ID; creation/use remains subject to D27 cookie rules. */
  readonly anonymous_id: string;
  /** Trusted exclusion flags; never accepted from an untrusted browser payload. */
  readonly is_internal: boolean;
  readonly is_test: boolean;
  readonly session_id?: string;
}

export type AnalyticsSubject =
  AnalyticsActorContext | AnalyticsAnonymousContext;

export type AnalyticsCaptureInput<Name extends AnalyticsEventName> = Readonly<{
  event_id?: string;
  event_name: Name;
  properties: AnalyticsPropertiesByName[Name];
  subject: AnalyticsSubject;
}>;

export type AnyAnalyticsCaptureInput = {
  [Name in AnalyticsEventName]: AnalyticsCaptureInput<Name>;
}[AnalyticsEventName];

export interface AnalyticsEnvelope {
  readonly actor_context?: Readonly<Omit<AnalyticsActorContext, "kind">>;
  readonly anonymous_context?: Readonly<
    Omit<AnalyticsAnonymousContext, "kind">
  >;
  readonly app_version: string;
  readonly environment: AnalyticsEnvironment;
  readonly event_id: string;
  readonly event_name: AnalyticsEventName;
  readonly event_source: "CLIENT_UX" | "SERVER_DOMAIN" | "SERVER_QUERY";
  readonly occurred_at: string;
  readonly platform: AnalyticsPlatform;
  readonly properties: Readonly<Record<string, string>>;
  readonly schema_version: number;
}

export type AnalyticsTransportKind = "NOOP" | "TEST" | "PROVIDER";

export interface AnalyticsTransport {
  readonly environment: AnalyticsEnvironment;
  readonly kind: AnalyticsTransportKind;
  deliver(event: AnalyticsEnvelope): Promise<void>;
}

export type AnalyticsDiagnosticCode =
  | "INVALID_EVENT"
  | "TRANSPORT_DISABLED"
  | "TRANSPORT_MISCONFIGURED"
  | "TRANSPORT_UNAVAILABLE";

export interface AnalyticsDiagnostic {
  readonly code: AnalyticsDiagnosticCode;
  readonly environment: AnalyticsEnvironment;
  readonly event_id?: string;
  readonly event_name?: AnalyticsEventName;
}

export type AnalyticsCaptureResult =
  | Readonly<{
      event_id: string;
      status: "DELIVERED";
    }>
  | Readonly<{
      event_id?: string;
      reason: AnalyticsDiagnosticCode;
      status: "DROPPED";
    }>;

export type AnalyticsReadiness =
  | Readonly<{ status: "ACTIVE" }>
  | Readonly<{ status: "DISABLED" }>
  | Readonly<{
      reason: "CROSS_ENVIRONMENT_TRANSPORT" | "TEST_TRANSPORT_IN_PRODUCTION";
      status: "MISCONFIGURED";
    }>;

export interface AnalyticsPort {
  /** Resolves to a result in all cases; analytics never rejects business work. */
  capture(input: AnyAnalyticsCaptureInput): Promise<AnalyticsCaptureResult>;
  readiness(): AnalyticsReadiness;
}
