"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const download =
  /^\/v1\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/download$/iu;
type Category = "ALL" | "PHOTO" | "DOCUMENT";
type Dict = Record<string, unknown>;
const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Number.isFinite(Date.parse(value));

export interface JobDocumentItem {
  readonly mediaAssetId: string;
  readonly kind: "PHOTO" | "DOCUMENT";
  readonly source: "WINNING_CONVERSATION";
  readonly sourceMessageId: string;
  readonly uploadedByUserId: string;
  readonly authorRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly uploadedAt: string;
  readonly capturedAt: string | null;
  readonly chronologicalAt: string;
  readonly displayFilename: string | null;
  readonly contentType: string;
  readonly downloadPath: string;
}
export interface JobDocumentPage {
  readonly items: readonly JobDocumentItem[];
  readonly nextCursor: {
    readonly chronologicalAt: string;
    readonly mediaAssetId: string;
  } | null;
}

export function parseJobDocumentPage(value: unknown): JobDocumentPage | null {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 50)
    return null;
  const ids = new Set<string>();
  for (const item of value.items as unknown[]) {
    if (
      !record(item) ||
      typeof item.mediaAssetId !== "string" ||
      !uuid.test(item.mediaAssetId) ||
      ids.has(item.mediaAssetId) ||
      (item.kind !== "PHOTO" && item.kind !== "DOCUMENT") ||
      item.source !== "WINNING_CONVERSATION" ||
      typeof item.sourceMessageId !== "string" ||
      !uuid.test(item.sourceMessageId) ||
      typeof item.uploadedByUserId !== "string" ||
      !uuid.test(item.uploadedByUserId) ||
      (item.authorRole !== "CUSTOMER" &&
        item.authorRole !== "PRIMARY_PROVIDER") ||
      !date(item.uploadedAt) ||
      (item.capturedAt !== null && !date(item.capturedAt)) ||
      !date(item.chronologicalAt) ||
      (item.displayFilename !== null &&
        typeof item.displayFilename !== "string") ||
      typeof item.contentType !== "string" ||
      (item.kind === "PHOTO" && !item.contentType.startsWith("image/")) ||
      (item.kind === "DOCUMENT" && item.contentType !== "application/pdf") ||
      typeof item.downloadPath !== "string" ||
      download.exec(item.downloadPath)?.[1]?.toLowerCase() !==
        item.mediaAssetId.toLowerCase()
    )
      return null;
    ids.add(item.mediaAssetId);
  }
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (!record(cursor) ||
      !date(cursor.chronologicalAt) ||
      typeof cursor.mediaAssetId !== "string" ||
      !uuid.test(cursor.mediaAssetId))
  )
    return null;
  return value as unknown as JobDocumentPage;
}

export async function loadJobDocumentPage(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly category: Category;
  readonly cursor?: JobDocumentPage["nextCursor"];
}): Promise<JobDocumentPage | null> {
  if (!uuid.test(input.jobId)) return null;
  const query = new URLSearchParams({ category: input.category, limit: "20" });
  if (input.cursor) {
    query.set("beforeAt", input.cursor.chronologicalAt);
    query.set("beforeId", input.cursor.mediaAssetId);
  }
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/documentation?${query.toString()}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    return response.ok ? parseJobDocumentPage(await response.json()) : null;
  } catch {
    return null;
  }
}

export function JobDocumentList({
  items,
  winningInvitationId,
}: {
  items: readonly JobDocumentItem[];
  winningInvitationId: string;
}) {
  if (items.length === 0)
    return <p>Zatiaľ nie sú pridané fotografie ani dokumenty.</p>;
  return (
    <ol className="job-documentation-list">
      {items.map((item) => (
        <li key={item.mediaAssetId}>
          {item.kind === "PHOTO" && (
            <a href={item.downloadPath}>
              {/* The URL is same-origin and the private delivery endpoint rechecks authorization. */}
              <img
                alt={item.displayFilename ?? "Fotografia zákazky"}
                loading="lazy"
                src={item.downloadPath}
              />
            </a>
          )}
          <p>
            <a href={item.downloadPath}>
              {item.displayFilename ??
                (item.kind === "PHOTO" ? "Fotografia" : "Dokument")}
            </a>
          </p>
          <p>
            {item.authorRole === "CUSTOMER"
              ? "Pridal zákazník"
              : "Pridal hlavný poskytovateľ"}{" "}
            ·{" "}
            <time dateTime={item.uploadedAt}>
              {new Date(item.uploadedAt).toLocaleString("sk-SK")}
            </time>
          </p>
          {item.capturedAt && (
            <p>
              Zachytené:{" "}
              <time dateTime={item.capturedAt}>
                {new Date(item.capturedAt).toLocaleString("sk-SK")}
              </time>
            </p>
          )}
          <p>
            <Link href={`/konverzacie/pozvanka/${winningInvitationId}`}>
              Pôvodná konverzácia
            </Link>
          </p>
        </li>
      ))}
    </ol>
  );
}

export function JobDocumentation({
  jobId,
  winningInvitationId,
}: {
  jobId: string;
  winningInvitationId: string;
}) {
  const [category, setCategory] = useState<Category>("ALL");
  const [page, setPage] = useState<JobDocumentPage | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setPage(null);
    setFailed(false);
    void loadJobDocumentPage({ fetch: globalThis.fetch, jobId, category }).then(
      (result) => {
        if (!active) return;
        setPage(result);
        setFailed(result === null);
      },
    );
    return () => {
      active = false;
    };
  }, [category, jobId]);
  const more = async () => {
    if (!page?.nextCursor || pending) return;
    setPending(true);
    const next = await loadJobDocumentPage({
      fetch: globalThis.fetch,
      jobId,
      category,
      cursor: page.nextCursor,
    });
    if (next === null) setFailed(true);
    else
      setPage({
        items: [...page.items, ...next.items],
        nextCursor: next.nextCursor,
      });
    setPending(false);
  };
  return (
    <section aria-labelledby="job-documentation">
      <h2 id="job-documentation">Fotografie a dokumenty</h2>
      <p>
        Chronologická dokumentácia z víťaznej konverzácie. Nie je súčasťou
        nemennej prijatej ponuky.
      </p>
      <div className="job-documentation-filters">
        {(["ALL", "PHOTO", "DOCUMENT"] as const).map((candidate) => (
          <button
            aria-pressed={category === candidate}
            key={candidate}
            onClick={() => setCategory(candidate)}
            type="button"
          >
            {candidate === "ALL"
              ? "Všetko"
              : candidate === "PHOTO"
                ? "Fotografie"
                : "Dokumenty"}
          </button>
        ))}
      </div>
      {page === null && !failed && (
        <p role="status">Načítava sa dokumentácia…</p>
      )}
      {page && (
        <JobDocumentList
          items={page.items}
          winningInvitationId={winningInvitationId}
        />
      )}
      {page?.nextCursor && (
        <button disabled={pending} onClick={() => void more()} type="button">
          Načítať ďalšie
        </button>
      )}
      {failed && (
        <p role="alert">Dokumentáciu sa nepodarilo bezpečne načítať.</p>
      )}
    </section>
  );
}
