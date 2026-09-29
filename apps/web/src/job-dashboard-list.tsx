"use client";

import React, { useEffect, useState } from "react";

import { ActionLink, Card, EmptyState, StatusBadge } from "./design-system";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JobListItem {
  id: string;
  state:
    | "CONFIRMED"
    | "IN_PROGRESS"
    | "COMPLETION_REQUESTED"
    | "COMPLETED"
    | "CANCELLED";
  acceptedAt: string;
  role: "CUSTOMER" | "PRIMARY_PROVIDER";
  providerDisplayName: string;
  requestTitle: string;
}
export type JobListLoadResult =
  { status: "OK"; jobs: readonly JobListItem[] } | { status: "UNAVAILABLE" };

const jobStatusPresentation = {
  CONFIRMED: { label: "Potvrdená", tone: "trust" },
  IN_PROGRESS: { label: "Práce prebiehajú", tone: "trust" },
  COMPLETION_REQUESTED: {
    label: "Čaká na potvrdenie dokončenia",
    tone: "warning",
  },
  COMPLETED: { label: "Dokončená", tone: "success" },
  CANCELLED: { label: "Zrušená", tone: "error" },
} as const satisfies Record<
  JobListItem["state"],
  {
    label: string;
    tone: "default" | "success" | "warning" | "error" | "trust";
  }
>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseJobList(payload: unknown): readonly JobListItem[] | null {
  if (
    !record(payload) ||
    !Array.isArray(payload.jobs) ||
    payload.jobs.length > 100
  )
    return null;
  const ids = new Set<string>();
  const rows: readonly unknown[] = payload.jobs as readonly unknown[];
  for (const item of rows) {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      !uuid.test(item.id) ||
      ids.has(item.id) ||
      ![
        "CONFIRMED",
        "IN_PROGRESS",
        "COMPLETION_REQUESTED",
        "COMPLETED",
        "CANCELLED",
      ].includes(item.state as string) ||
      typeof item.acceptedAt !== "string" ||
      Number.isNaN(Date.parse(item.acceptedAt)) ||
      (item.role !== "CUSTOMER" && item.role !== "PRIMARY_PROVIDER") ||
      typeof item.providerDisplayName !== "string" ||
      typeof item.requestTitle !== "string"
    )
      return null;
    ids.add(item.id);
  }
  return rows as readonly JobListItem[];
}

export async function loadJobList(
  fetcher: typeof fetch,
): Promise<JobListLoadResult> {
  try {
    const response = await fetcher.call(globalThis, "/v1/me/jobs", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return { status: "UNAVAILABLE" };
    const jobs = parseJobList(await response.json());
    return jobs === null ? { status: "UNAVAILABLE" } : { status: "OK", jobs };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function JobListView({ jobs }: { jobs: readonly JobListItem[] }) {
  if (jobs.length === 0)
    return (
      <EmptyState
        action={<ActionLink href="/dopyt">Vytvoriť dopyt</ActionLink>}
        description={
          <p>
            Keď prijmete ponuku remeselníka, potvrdená zákazka sa zobrazí tu.
          </p>
        }
        title="Zatiaľ nemáte potvrdenú zákazku"
      />
    );

  return (
    <ul aria-label="Zákazky" className="job-list">
      {jobs.map((job) => {
        const status = jobStatusPresentation[job.state];
        return (
          <li className="job-list__item" key={job.id}>
            <Card className="job-list-card">
              <div className="job-list-card__heading">
                <h2>{job.requestTitle}</h2>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </div>
              {job.role === "CUSTOMER" ? (
                <p>Hlavný poskytovateľ: {job.providerDisplayName}</p>
              ) : (
                <p>Vaša rola: hlavný poskytovateľ</p>
              )}
              <p>
                <time dateTime={job.acceptedAt}>
                  Potvrdená{" "}
                  {new Date(job.acceptedAt).toLocaleString("sk-SK", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </p>
              <ActionLink href={`/zakazky/${job.id}`}>
                Otvoriť zákazku
              </ActionLink>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

export function JobDashboardList() {
  const [result, setResult] = useState<JobListLoadResult | null>(null);
  useEffect(() => {
    let active = true;
    void loadJobList(globalThis.fetch).then((loaded) => {
      if (active) setResult(loaded);
    });
    return () => {
      active = false;
    };
  }, []);
  if (result === null) return <p role="status">Načítavajú sa zákazky…</p>;
  if (result.status !== "OK")
    return (
      <p role="alert">Zákazky sa nepodarilo načítať. Skúste to znova neskôr.</p>
    );
  return <JobListView jobs={result.jobs} />;
}
