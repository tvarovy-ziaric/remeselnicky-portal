"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  loadJobDocumentPage,
  type JobDocumentItem,
  type JobDocumentPage,
} from "./job-documentation";
import {
  commandAttempt,
  loadOperationalPage,
  sendOperationalCommand,
  type IssueComment,
  type IssueItem,
  type OperationalPage,
  type ProgressItem,
} from "./job-operational-data";

type JobState =
  | "CONFIRMED"
  | "IN_PROGRESS"
  | "COMPLETION_REQUESTED"
  | "COMPLETED"
  | "CANCELLED";
const editable = (state: JobState) =>
  state === "CONFIRMED" || state === "IN_PROGRESS";
type Role = "CUSTOMER" | "PRIMARY_PROVIDER";
const date = (value: string) => new Date(value).toLocaleString("sk-SK");
const kindLabel: Record<IssueItem["kind"], string> = {
  PROBLEM: "Problém",
  DELAY: "Meškanie",
  WAITING: "Čakanie",
};
const roleLabel: Record<Role, string> = {
  CUSTOMER: "Zákazník",
  PRIMARY_PROVIDER: "Hlavný poskytovateľ",
};

export function OperationalMedia({
  media,
}: {
  media: readonly JobDocumentItem[];
}) {
  if (media.length === 0) return null;
  return (
    <div>
      <h4>Pripojená dokumentácia</h4>
      <ul>
        {media.map((item) => (
          <li key={item.mediaAssetId}>
            {item.kind === "PHOTO" && (
              <a href={item.downloadPath}>
                <img
                  alt={item.displayFilename ?? "Fotografia z priebehu zákazky"}
                  loading="lazy"
                  src={item.downloadPath}
                />
              </a>
            )}
            <a href={item.downloadPath}>
              {item.displayFilename ??
                (item.kind === "PHOTO" ? "Fotografia" : "Dokument PDF")}
            </a>
            <p>
              Z víťaznej konverzácie ·{" "}
              {item.authorRole === "CUSTOMER"
                ? "pridal zákazník"
                : "pridal hlavný poskytovateľ"}{" "}
              · <time dateTime={item.uploadedAt}>{date(item.uploadedAt)}</time>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobMediaPicker({
  jobId,
  category,
  selectedIds,
  onChange,
}: {
  jobId: string;
  category: "PHOTO" | "ALL";
  selectedIds: readonly string[];
  onChange: (ids: readonly string[]) => void;
}) {
  const [page, setPage] = useState<JobDocumentPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(async () => {
    setRefreshing(true);
    const result = await loadJobDocumentPage({
      fetch: globalThis.fetch,
      jobId,
      category,
    });
    if (result) {
      setPage(result);
      setFailed(false);
    } else setFailed(true);
    setRefreshing(false);
  }, [jobId, category]);
  useEffect(() => {
    void load();
  }, [load]);
  const more = async () => {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    const result = await loadJobDocumentPage({
      fetch: globalThis.fetch,
      jobId,
      category,
      cursor: page.nextCursor,
    });
    if (result)
      setPage({
        items: [...page.items, ...result.items],
        nextCursor: result.nextCursor,
      });
    else setFailed(true);
    setLoadingMore(false);
  };
  const toggle = (id: string) => {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((candidate) => candidate !== id)
        : selectedIds.length >= 5
          ? selectedIds
          : [...selectedIds, id],
    );
  };
  return (
    <fieldset>
      <legend>
        {category === "PHOTO"
          ? "Fotografie k správe"
          : "Fotografie a PDF k problému"}
      </legend>
      <p>
        Najprv pridajte súbor do víťaznej konverzácie. Tu môžete pripojiť
        najviac päť už overených súkromných súborov tejto zákazky. Ich pôvod
        zostáva zachovaný.
      </p>
      {page === null && !failed && <p>Načítava sa dokumentácia…</p>}
      {page?.items.length === 0 && (
        <p>Zatiaľ nie sú dostupné súbory na pripojenie.</p>
      )}
      {page && page.items.length > 0 && (
        <div>
          {page.items.map((item) => (
            <label key={item.mediaAssetId}>
              <input
                checked={selectedIds.includes(item.mediaAssetId)}
                disabled={
                  selectedIds.length >= 5 &&
                  !selectedIds.includes(item.mediaAssetId)
                }
                onChange={() => toggle(item.mediaAssetId)}
                type="checkbox"
              />
              {item.displayFilename ??
                (item.kind === "PHOTO" ? "Fotografia" : "Dokument PDF")}{" "}
              · {item.kind === "PHOTO" ? "fotografia" : "PDF"} ·{" "}
              {date(item.uploadedAt)}
            </label>
          ))}
        </div>
      )}
      {page?.nextCursor && (
        <button
          disabled={loadingMore}
          onClick={() => void more()}
          type="button"
        >
          Načítať ďalšiu dokumentáciu
        </button>
      )}
      {failed && (
        <p role="alert">Dokumentáciu sa nepodarilo načítať. Skúste to znova.</p>
      )}
      <button disabled={refreshing} onClick={() => void load()} type="button">
        Obnoviť dokumentáciu
      </button>
      <p>Vybrané: {selectedIds.length} z 5</p>
    </fieldset>
  );
}

export function ProgressItems({
  items,
  jobId,
  canAcknowledge,
  onAcknowledge,
  busyId,
}: {
  items: readonly ProgressItem[];
  jobId?: string;
  canAcknowledge: boolean;
  onAcknowledge?: (id: string) => void;
  busyId?: string | null;
}) {
  if (items.length === 0)
    return <p>Zatiaľ nie sú pridané správy o priebehu.</p>;
  return (
    <ol>
      {items.map((item) => (
        <li key={item.id}>
          <p>{item.body}</p>
          <OperationalMedia media={item.media} />
          <p>
            {item.authorDisplayName} ·{" "}
            <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
          </p>
          {jobId && (
            <p>
              <Link href={`/zakazky/${jobId}/priebeh/${item.id}`}>
                Otvoriť správu o priebehu
              </Link>
            </p>
          )}
          {item.acknowledgedAt ? (
            <p>
              Prečítané zákazníkom ·{" "}
              <time dateTime={item.acknowledgedAt}>
                {date(item.acknowledgedAt)}
              </time>
            </p>
          ) : canAcknowledge ? (
            <button
              disabled={busyId === item.id}
              onClick={() => onAcknowledge?.(item.id)}
              type="button"
            >
              Potvrdiť prečítanie
            </button>
          ) : (
            <p>Zatiaľ nepotvrdené prečítanie</p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function IssueItems({
  items,
  jobId,
  jobState,
}: {
  items: readonly IssueItem[];
  jobId: string;
  jobState: JobState;
}) {
  if (items.length === 0)
    return <p>Zatiaľ nie je zaznamenaný problém ani čakanie.</p>;
  return (
    <ol>
      {items.map((item) => (
        <li key={item.id}>
          <h3>{kindLabel[item.kind]}</h3>
          <p>{item.body}</p>
          <OperationalMedia media={item.media} />
          <p>
            {item.authorDisplayName} ({roleLabel[item.authorRole]}) ·{" "}
            <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
          </p>
          <p>
            <Link href={`/zakazky/${jobId}/problemy/${item.id}`}>
              Otvoriť záznam problému
            </Link>
          </p>
          <IssueDiscussion
            jobId={jobId}
            issueId={item.id}
            jobState={jobState}
          />
        </li>
      ))}
    </ol>
  );
}

export function IssueComments({ items }: { items: readonly IssueComment[] }) {
  if (items.length === 0) return <p>Zatiaľ bez komentára.</p>;
  return (
    <ol>
      {items.map((item) => (
        <li key={item.id}>
          <p>{item.body}</p>
          <p>
            {item.authorDisplayName} ({roleLabel[item.authorRole]}) ·{" "}
            <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
          </p>
        </li>
      ))}
    </ol>
  );
}

export function IssueDiscussion({
  jobId,
  issueId,
  jobState,
}: {
  jobId: string;
  issueId: string;
  jobState: JobState;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<OperationalPage<IssueComment> | null>(null);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ commandId: string; intent: string } | null>(null);
  const load = useCallback(async () => {
    const result = await loadOperationalPage({
      fetch: globalThis.fetch,
      kind: "comments",
      jobId,
      issueId,
    });
    if (result.status === "OK") setPage(result.page);
    else setNotice("Komentáre sa nepodarilo načítať.");
  }, [jobId, issueId]);
  const toggle = () => {
    if (!open && page === null) void load();
    setOpen(!open);
  };
  const more = async () => {
    if (!page?.nextCursor || pending) return;
    setPending(true);
    const result = await loadOperationalPage({
      fetch: globalThis.fetch,
      kind: "comments",
      jobId,
      issueId,
      cursor: page.nextCursor,
    });
    if (result.status === "OK")
      setPage({
        ...result.page,
        items: [...page.items, ...result.page.items],
      });
    else setNotice("Ďalšie komentáre sa nepodarilo načítať.");
    setPending(false);
  };
  const submit = async () => {
    const normalized = body.trim();
    if (normalized.length < 1 || normalized.length > 2_000 || pending) return;
    retry.current = commandAttempt(retry.current, normalized, () =>
      crypto.randomUUID(),
    );
    setPending(true);
    setNotice("");
    const result = await sendOperationalCommand({
      fetch: globalThis.fetch,
      jobId,
      path: `issues/${issueId}/comments`,
      commandId: retry.current.commandId,
      body: normalized,
    });
    if (result === "OK") {
      retry.current = null;
      setBody("");
      await load();
    } else
      setNotice(
        result === "AUTH_REQUIRED"
          ? "Relácia sa skončila. Prihláste sa znova."
          : "Komentár sa nepodarilo potvrdiť. Skúste to znova; opakovanie je bezpečné.",
      );
    setPending(false);
  };
  return (
    <div>
      <button aria-expanded={open} onClick={toggle} type="button">
        {open ? "Skryť komentáre" : "Zobraziť komentáre"}
      </button>
      {open && (
        <div>
          {page ? (
            <>
              <IssueComments items={page.items} />
              {page.nextCursor && (
                <button
                  disabled={pending}
                  onClick={() => void more()}
                  type="button"
                >
                  Načítať staršie komentáre
                </button>
              )}
              {editable(jobState) && page.canCreate && (
                <div>
                  <label htmlFor={`issue-comment-${issueId}`}>
                    Pridať komentár
                  </label>
                  <textarea
                    id={`issue-comment-${issueId}`}
                    maxLength={2000}
                    onChange={(event) => setBody(event.target.value)}
                    value={body}
                  />
                  <button
                    disabled={pending || body.trim().length === 0}
                    onClick={() => void submit()}
                    type="button"
                  >
                    Pridať komentár
                  </button>
                </div>
              )}
            </>
          ) : (
            <p>Načítavajú sa komentáre…</p>
          )}
          {notice && <p role="alert">{notice}</p>}
        </div>
      )}
    </div>
  );
}

export function JobOperations({
  jobId,
  role,
  jobState,
}: {
  jobId: string;
  role: Role;
  jobState: JobState;
}) {
  const [progress, setProgress] =
    useState<OperationalPage<ProgressItem> | null>(null);
  const [issues, setIssues] = useState<OperationalPage<IssueItem> | null>(null);
  const [progressBody, setProgressBody] = useState("");
  const [progressMediaIds, setProgressMediaIds] = useState<readonly string[]>(
    [],
  );
  const [issueBody, setIssueBody] = useState("");
  const [issueMediaIds, setIssueMediaIds] = useState<readonly string[]>([]);
  const [issueKind, setIssueKind] = useState<IssueItem["kind"]>("PROBLEM");
  const [pending, setPending] = useState(false);
  const [ackId, setAckId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const progressRetry = useRef<{
    commandId: string;
    intent: { body: string; mediaAssetIds: readonly string[] };
  } | null>(null);
  const issueRetry = useRef<{
    commandId: string;
    intent: {
      kind: IssueItem["kind"];
      body: string;
      mediaAssetIds: readonly string[];
    };
  } | null>(null);
  const ackRetries = useRef(new Map<string, string>());
  const refreshProgress = useCallback(async () => {
    const result = await loadOperationalPage({
      fetch: globalThis.fetch,
      kind: "progress",
      jobId,
    });
    if (result.status === "OK") setProgress(result.page);
    else setNotice("Priebeh zákazky sa nepodarilo načítať.");
  }, [jobId]);
  const refreshIssues = useCallback(async () => {
    const result = await loadOperationalPage({
      fetch: globalThis.fetch,
      kind: "issues",
      jobId,
    });
    if (result.status === "OK") setIssues(result.page);
    else setNotice("Problémy zákazky sa nepodarilo načítať.");
  }, [jobId]);
  useEffect(() => {
    void refreshProgress();
    void refreshIssues();
  }, [refreshProgress, refreshIssues]);
  const moreProgress = async () => {
    if (!progress?.nextCursor || pending) return;
    setPending(true);
    const result = await loadOperationalPage({
      fetch: globalThis.fetch,
      kind: "progress",
      jobId,
      cursor: progress.nextCursor,
    });
    if (result.status === "OK")
      setProgress({
        ...result.page,
        items: [...progress.items, ...result.page.items],
      });
    else setNotice("Staršie správy o priebehu sa nepodarilo načítať.");
    setPending(false);
  };
  const moreIssues = async () => {
    if (!issues?.nextCursor || pending) return;
    setPending(true);
    const result = await loadOperationalPage({
      fetch: globalThis.fetch,
      kind: "issues",
      jobId,
      cursor: issues.nextCursor,
    });
    if (result.status === "OK")
      setIssues({
        ...result.page,
        items: [...issues.items, ...result.page.items],
      });
    else setNotice("Staršie problémy sa nepodarilo načítať.");
    setPending(false);
  };
  const createProgress = async () => {
    const body = progressBody.trim();
    if (body.length < 1 || body.length > 2_000 || pending) return;
    progressRetry.current = commandAttempt(
      progressRetry.current,
      { body, mediaAssetIds: progressMediaIds },
      () => crypto.randomUUID(),
    );
    setPending(true);
    setNotice("");
    const result = await sendOperationalCommand({
      fetch: globalThis.fetch,
      jobId,
      path: "progress",
      commandId: progressRetry.current.commandId,
      body,
      mediaAssetIds: progressMediaIds,
    });
    if (result === "OK") {
      progressRetry.current = null;
      setProgressBody("");
      setProgressMediaIds([]);
      await refreshProgress();
    } else
      setNotice(
        result === "AUTH_REQUIRED"
          ? "Relácia sa skončila. Prihláste sa znova."
          : "Správu sa nepodarilo potvrdiť. Skúste to znova bez zmeny textu a príloh.",
      );
    setPending(false);
  };
  const createIssue = async () => {
    const body = issueBody.trim();
    if (body.length < 8 || body.length > 2_000 || pending) return;
    issueRetry.current = commandAttempt(
      issueRetry.current,
      { kind: issueKind, body, mediaAssetIds: issueMediaIds },
      () => crypto.randomUUID(),
    );
    setPending(true);
    setNotice("");
    const result = await sendOperationalCommand({
      fetch: globalThis.fetch,
      jobId,
      path: "issues",
      commandId: issueRetry.current.commandId,
      kind: issueKind,
      body,
      mediaAssetIds: issueMediaIds,
    });
    if (result === "OK") {
      issueRetry.current = null;
      setIssueBody("");
      setIssueMediaIds([]);
      await refreshIssues();
    } else
      setNotice(
        result === "AUTH_REQUIRED"
          ? "Relácia sa skončila. Prihláste sa znova."
          : "Záznam sa nepodarilo potvrdiť. Skúste to znova bez zmeny textu a príloh.",
      );
    setPending(false);
  };
  const acknowledge = async (id: string) => {
    if (ackId !== null || !editable(jobState) || role !== "CUSTOMER") return;
    const commandId = ackRetries.current.get(id) ?? crypto.randomUUID();
    ackRetries.current.set(id, commandId);
    setAckId(id);
    setNotice("");
    const result = await sendOperationalCommand({
      fetch: globalThis.fetch,
      jobId,
      path: `progress/${id}/acknowledge`,
      commandId,
    });
    if (result === "OK") {
      ackRetries.current.delete(id);
      await refreshProgress();
    } else
      setNotice(
        result === "AUTH_REQUIRED"
          ? "Relácia sa skončila. Prihláste sa znova."
          : "Potvrdenie sa nepodarilo overiť. Skúste to znova; opakovanie je bezpečné.",
      );
    setAckId(null);
  };
  return (
    <>
      <section aria-labelledby="job-progress">
        <h2 id="job-progress">Priebeh prác</h2>
        <p>
          Informačné správy o vykonávaní prác. Potvrdenie prečítania nie je
          súhlasom so zmenou ceny, rozsahu ani termínu.
        </p>
        {progress ? (
          <>
            <ProgressItems
              items={progress.items}
              jobId={jobId}
              canAcknowledge={role === "CUSTOMER" && editable(jobState)}
              busyId={ackId}
              onAcknowledge={(id) => void acknowledge(id)}
            />
            {progress.nextCursor && (
              <button
                disabled={pending}
                onClick={() => void moreProgress()}
                type="button"
              >
                Načítať starší priebeh
              </button>
            )}
            {role === "PRIMARY_PROVIDER" &&
              editable(jobState) &&
              progress.canCreate && (
                <div>
                  <label htmlFor="job-progress-body">
                    Nová správa o priebehu
                  </label>
                  <textarea
                    id="job-progress-body"
                    maxLength={2000}
                    onChange={(event) => setProgressBody(event.target.value)}
                    value={progressBody}
                  />
                  <JobMediaPicker
                    category="PHOTO"
                    jobId={jobId}
                    onChange={setProgressMediaIds}
                    selectedIds={progressMediaIds}
                  />
                  <button
                    disabled={pending || progressBody.trim().length === 0}
                    onClick={() => void createProgress()}
                    type="button"
                  >
                    Pridať správu
                  </button>
                </div>
              )}
          </>
        ) : (
          <p>Načítava sa priebeh…</p>
        )}
      </section>
      <section aria-labelledby="job-issues">
        <h2 id="job-issues">Problémy a čakanie</h2>
        <p>
          Záznam problému ani komentár automaticky nepozastavia zákazku, nezačnú
          spor a nemenia prijatú dohodu. Zmeny dohody vyžadujú samostatné
          potvrdenie oboch strán.
        </p>
        {issues ? (
          <>
            <IssueItems
              items={issues.items}
              jobId={jobId}
              jobState={jobState}
            />
            {issues.nextCursor && (
              <button
                disabled={pending}
                onClick={() => void moreIssues()}
                type="button"
              >
                Načítať staršie problémy
              </button>
            )}
            {editable(jobState) && issues.canCreate && (
              <div>
                <label htmlFor="job-issue-kind">Typ záznamu</label>
                <select
                  id="job-issue-kind"
                  onChange={(event) =>
                    setIssueKind(event.target.value as IssueItem["kind"])
                  }
                  value={issueKind}
                >
                  <option value="PROBLEM">Problém</option>
                  <option value="DELAY">Meškanie</option>
                  <option value="WAITING">Čakanie</option>
                </select>
                <label htmlFor="job-issue-body">Čo sa deje?</label>
                <textarea
                  id="job-issue-body"
                  maxLength={2000}
                  onChange={(event) => setIssueBody(event.target.value)}
                  value={issueBody}
                />
                <JobMediaPicker
                  category="ALL"
                  jobId={jobId}
                  onChange={setIssueMediaIds}
                  selectedIds={issueMediaIds}
                />
                <button
                  disabled={pending || issueBody.trim().length < 8}
                  onClick={() => void createIssue()}
                  type="button"
                >
                  Pridať záznam
                </button>
              </div>
            )}
          </>
        ) : (
          <p>Načítavajú sa problémy…</p>
        )}
      </section>
      {notice && <p role="alert">{notice}</p>}
    </>
  );
}
