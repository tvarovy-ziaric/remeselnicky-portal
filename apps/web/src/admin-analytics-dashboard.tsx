"use client";

import { useEffect, useState } from "react";

import {
  ALPHA_KPI_PRESENTATION,
  parseAlphaDashboard,
  type AlphaDashboardView,
  type AlphaMetricView,
} from "./admin-analytics-model";

type DashboardState =
  | { readonly status: "LOADING" }
  | { readonly status: "UNAVAILABLE" }
  | { readonly dashboard: AlphaDashboardView; readonly status: "READY" };

export function AdminAnalyticsDashboard() {
  const [state, setState] = useState<DashboardState>({ status: "LOADING" });

  useEffect(() => {
    const controller = new AbortController();
    void loadAlphaDashboard(controller.signal).then((dashboard) => {
      if (!controller.signal.aborted) {
        setState(
          dashboard === undefined
            ? { status: "UNAVAILABLE" }
            : { dashboard, status: "READY" },
        );
      }
    });
    return () => controller.abort();
  }, []);

  if (state.status !== "READY") {
    return (
      <section className="admin-panel" aria-live="polite">
        <p className="admin-kicker">Web Alpha · D28</p>
        <h2>
          {state.status === "LOADING"
            ? "Načítavam analytiku"
            : "Analytika nie je dostupná"}
        </h2>
        <p>
          {state.status === "LOADING"
            ? "Počítame agregované ukazovatele bez osobných údajov."
            : "Server neposkytol platný agregovaný prehľad. Skúste to neskôr."}
        </p>
      </section>
    );
  }

  const { dashboard } = state;
  return (
    <section
      className="admin-panel admin-analytics"
      aria-labelledby="admin-analytics-title"
    >
      <header className="admin-analytics-header">
        <div>
          <p className="admin-kicker">Web Alpha · D28</p>
          <h2 id="admin-analytics-title">Prevádzkový prehľad</h2>
        </div>
        <p>
          {formatDate(dashboard.range.from)} – {formatDate(dashboard.range.to)}
          <small>Definícia {dashboard.definitionVersion}</small>
        </p>
      </header>
      {dashboard.groups.map((group) => (
        <section
          className="admin-analytics-group"
          key={group.id}
          aria-labelledby={`analytics-${group.id}`}
        >
          <h3 id={`analytics-${group.id}`}>{group.label}</h3>
          <div className="admin-metric-grid">
            {group.metrics.map((metric) => (
              <article key={metric.definitionId}>
                <strong>{formatMetric(metric)}</strong>
                <span>
                  {ALPHA_KPI_PRESENTATION[metric.definitionId]?.label}
                </span>
                <small>{formatBasis(metric)}</small>
              </article>
            ))}
          </div>
        </section>
      ))}
      <p className="admin-analytics-note">
        Len agregované reálne dáta. TEST a INTERNAL prevádzka sa do ukazovateľov
        nezapočítava.
      </p>
    </section>
  );
}

export async function loadAlphaDashboard(
  signal: AbortSignal,
): Promise<AlphaDashboardView | undefined> {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const response = await fetch(
      `/v1/admin/analytics/alpha?${query.toString()}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal,
      },
    );
    if (!response.ok) return undefined;
    return parseAlphaDashboard(await response.json());
  } catch {
    return undefined;
  }
}

function formatMetric(metric: AlphaMetricView): string {
  if (metric.value === null) return "—";
  const unit = ALPHA_KPI_PRESENTATION[metric.definitionId]?.unit;
  if (unit === "COUNT")
    return new Intl.NumberFormat("sk-SK").format(metric.value);
  if (unit === "HOURS")
    return `${new Intl.NumberFormat("sk-SK", { maximumFractionDigits: 1 }).format(metric.value)} h`;
  if (
    metric.definitionId === "mean_candidates_per_search" ||
    metric.definitionId === "quotes_per_engaged_provider" ||
    metric.definitionId === "completion_attempts_per_completed_job"
  ) {
    return new Intl.NumberFormat("sk-SK", { maximumFractionDigits: 2 }).format(
      metric.value,
    );
  }
  return new Intl.NumberFormat("sk-SK", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(metric.value);
}

function formatBasis(metric: AlphaMetricView): string {
  if (metric.denominator === null) return "Počet";
  return `Základ: ${new Intl.NumberFormat("sk-SK").format(metric.denominator)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("sk-SK", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}
