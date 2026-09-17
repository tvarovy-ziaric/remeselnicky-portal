"use client";

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import { loadJobDashboard, type JobDashboardData } from "./job-dashboard";
import {
  parseIssuePage,
  parseProgressPage,
  sendOperationalCommand,
  type IssueItem,
  type ProgressItem,
} from "./job-operational-data";
import { IssueItems, ProgressItems } from "./job-operations";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type DetailKind = "progress" | "issues";
type DetailItem = ProgressItem | IssueItem;
export type DetailLoad =
  | { readonly status: "OK"; readonly item: DetailItem }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" };

export async function loadJobOperationalDetail(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly itemId: string;
  readonly kind: DetailKind;
}): Promise<DetailLoad> {
  if (!uuid.test(input.jobId) || !uuid.test(input.itemId))
    return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/${input.kind}/${input.itemId}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const raw: unknown = await response.json();
    const page =
      input.kind === "progress"
        ? parseProgressPage(
            { items: [raw], canCreate: false, nextCursor: null },
            input.jobId,
          )
        : parseIssuePage(
            { items: [raw], canCreate: false, nextCursor: null },
            input.jobId,
          );
    const item = page?.items[0];
    return item?.id === input.itemId
      ? { status: "OK", item }
      : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function JobOperationDetail({
  jobId,
  itemId,
  kind,
}: {
  jobId: string;
  itemId: string;
  kind: DetailKind;
}) {
  const [job, setJob] = useState<JobDashboardData | null>(null);
  const [item, setItem] = useState<DetailItem | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "AUTH_REQUIRED" | "UNAVAILABLE" | "OK"
  >("LOADING");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const retry = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      loadJobDashboard({ fetch: globalThis.fetch, jobId }),
      loadJobOperationalDetail({
        fetch: globalThis.fetch,
        jobId,
        itemId,
        kind,
      }),
    ]).then(([dashboard, detail]) => {
      if (!active) return;
      if (dashboard.status !== "OK" || detail.status !== "OK") {
        setStatus(
          detail.status === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "UNAVAILABLE",
        );
        return;
      }
      setJob(dashboard.job);
      setItem(detail.item);
      setStatus("OK");
    });
    return () => {
      active = false;
    };
  }, [jobId, itemId, kind]);
  const acknowledge = async () => {
    if (!job || !item || kind !== "progress" || busy) return;
    retry.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice("");
    const result = await sendOperationalCommand({
      fetch: globalThis.fetch,
      jobId,
      path: `progress/${itemId}/acknowledge`,
      commandId: retry.current,
    });
    if (result === "OK") {
      retry.current = null;
      const refreshed = await loadJobOperationalDetail({
        fetch: globalThis.fetch,
        jobId,
        itemId,
        kind: "progress",
      });
      if (refreshed.status === "OK") setItem(refreshed.item);
      else
        setNotice("Potvrdenie sa uložilo, ale záznam sa nepodarilo obnoviť.");
    } else
      setNotice(
        result === "AUTH_REQUIRED"
          ? "Relácia sa skončila. Prihláste sa znova."
          : "Potvrdenie sa nepodarilo overiť. Skúste to znova.",
      );
    setBusy(false);
  };
  if (status === "LOADING")
    return <p role="status">Načítava sa súkromný záznam…</p>;
  if (status === "AUTH_REQUIRED")
    return <p role="alert">Najprv sa prihláste.</p>;
  if (status !== "OK" || !job || !item)
    return <p role="alert">Záznam nie je dostupný.</p>;
  return (
    <section className="invitation-detail">
      <p className="eyebrow">Súkromný záznam zákazky</p>
      <h1>
        {kind === "progress" ? "Správa o priebehu" : "Problém alebo čakanie"}
      </h1>
      <p>
        Záznam nemení prijatú dohodu. Potvrdenie prečítania nie je súhlasom so
        zmenou ceny, rozsahu ani termínu.
      </p>
      {kind === "progress" ? (
        <ProgressItems
          items={[item as ProgressItem]}
          canAcknowledge={job.role === "CUSTOMER" && job.state !== "CANCELLED"}
          busyId={busy ? itemId : null}
          onAcknowledge={() => void acknowledge()}
        />
      ) : (
        <IssueItems
          items={[item as IssueItem]}
          jobId={jobId}
          jobState={job.state}
        />
      )}
      {notice && <p role="alert">{notice}</p>}
      <p>
        <Link href={`/zakazky/${jobId}`}>Späť na zákazku</Link>
      </p>
    </section>
  );
}
