"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";

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
  if (jobs.length === 0) return <p>Zatiaľ nemáte potvrdenú zákazku.</p>;
  return (
    <ul className="invitation-inbox">
      {jobs.map((job) => (
        <li key={job.id}>
          <Link href={`/zakazky/${job.id}`}>
            <strong>{job.requestTitle}</strong>
            <span>Hlavný poskytovateľ: {job.providerDisplayName}</span>
            <span>
              Potvrdená {new Date(job.acceptedAt).toLocaleString("sk-SK")}
            </span>
            <span>
              Stav:{" "}
              {job.state === "CONFIRMED"
                ? "Potvrdená"
                : job.state === "IN_PROGRESS"
                  ? "Prebieha"
                  : job.state === "COMPLETION_REQUESTED"
                    ? "Čaká na potvrdenie dokončenia"
                    : job.state === "COMPLETED"
                      ? "Dokončená"
                      : "Zrušená"}
            </span>
          </Link>
        </li>
      ))}
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
