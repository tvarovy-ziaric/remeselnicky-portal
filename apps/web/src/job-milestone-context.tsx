"use client";

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import { loadJobDocumentPage, type JobDocumentPage } from "./job-documentation";
import {
  loadMilestoneContextPage,
  loadMilestoneProposal,
  sendMilestoneContextCommand,
  type MilestoneComment,
  type MilestoneContextCommand,
  type MilestoneContextCursor,
  type MilestoneContextPage,
  type MilestoneMedia,
  type MilestoneProposal,
} from "./job-milestone-context-data";
import type { MilestoneItem } from "./job-milestone-data";

const when = (value: string) => new Date(value).toLocaleString("sk-SK");
const day = (value: string | null) =>
  value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString("sk-SK", {
        timeZone: "UTC",
      })
    : null;
const plan = (start: string | null, end: string | null) =>
  start && end
    ? `${day(start)} – ${day(end)}`
    : start
      ? `od ${day(start)}`
      : end
        ? `do ${day(end)}`
        : "bez dátumu";
const roleName: Record<MilestoneComment["authorRole"], string> = {
  CUSTOMER: "Zákazník",
  PRIMARY_PROVIDER: "Hlavný poskytovateľ",
  PARTICIPANT: "Účastník zákazky",
};
const commandError = (status: string) =>
  status === "AUTH_REQUIRED"
    ? "Relácia sa skončila. Prihláste sa znova."
    : status === "CONFLICT"
      ? "Údaje sa medzitým zmenili. Obnovte prehľad a skontrolujte aktuálny stav."
      : "Výsledok sa nepodarilo potvrdiť. Zopakujte nezmenenú akciu alebo obnovte prehľad.";
const validDraft = (
  title: string,
  description: string,
  start: string,
  end: string,
) =>
  title.trim().length > 0 &&
  title.length <= 160 &&
  description.length <= 2_000 &&
  (!start || !end || start <= end);

export function MilestoneProposalItems({
  items,
  jobId,
  pending,
  onDecision,
}: {
  items: readonly MilestoneProposal[];
  jobId: string;
  pending: boolean;
  onDecision?: (id: string, decision: "ACCEPT" | "DECLINE") => void;
}) {
  if (items.length === 0) return <p>Zatiaľ bez návrhov zákazníka.</p>;
  return (
    <ol>
      {items.map((item) => (
        <li key={item.id}>
          <h4>{item.title}</h4>
          <p>
            {item.targetMilestoneId
              ? "Návrh na úpravu existujúceho míľnika"
              : "Návrh nového míľnika"}
          </p>
          {item.description && <p>{item.description}</p>}
          <p>
            Navrhovaný prevádzkový plán:{" "}
            {plan(item.plannedStartOn, item.plannedEndOn)}
          </p>
          <p>
            Navrhnuté{" "}
            <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
          </p>
          <p>
            <Link href={`/zakazky/${jobId}/navrhy/${item.id}`}>
              Otvoriť návrh
            </Link>
          </p>
          {item.decision === null ? (
            <p>Čaká na rozhodnutie poskytovateľa.</p>
          ) : (
            <p>
              {item.decision === "ACCEPT" ? "Prijaté" : "Odmietnuté"}
              {item.decidedAt && (
                <>
                  {" "}
                  ·{" "}
                  <time dateTime={item.decidedAt}>{when(item.decidedAt)}</time>
                </>
              )}
            </p>
          )}
          {item.appliedMilestoneId && (
            <p>
              <Link
                href={`/zakazky/${jobId}/milniky/${item.appliedMilestoneId}`}
              >
                Otvoriť výsledný míľnik
              </Link>
            </p>
          )}
          {item.canDecide && item.decision === null && onDecision && (
            <div>
              <button
                disabled={pending}
                type="button"
                onClick={() => onDecision(item.id, "ACCEPT")}
              >
                Prijať prevádzkový návrh
              </button>
              <button
                disabled={pending}
                type="button"
                onClick={() => onDecision(item.id, "DECLINE")}
              >
                Odmietnuť návrh
              </button>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export function JobMilestoneProposals({
  jobId,
  role,
  jobState,
  milestones,
}: {
  jobId: string;
  role: "CUSTOMER" | "PRIMARY_PROVIDER";
  jobState:
    | "CONFIRMED"
    | "IN_PROGRESS"
    | "COMPLETION_REQUESTED"
    | "COMPLETED"
    | "CANCELLED";
  milestones: readonly MilestoneItem[];
}) {
  const writable = jobState === "CONFIRMED" || jobState === "IN_PROGRESS";
  const [open, setOpen] = useState(false);
  const [page, setPage] =
    useState<MilestoneContextPage<MilestoneProposal> | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [target, setTarget] = useState("");
  const attempts = useRef(new Map<string, { intent: string; id: string }>());
  useEffect(() => {
    setOpen(false);
    setPage(null);
    setNotice("");
    attempts.current.clear();
  }, [jobId]);
  const load = async (cursor?: MilestoneContextCursor) => {
    const result = await loadMilestoneContextPage({
      fetch: globalThis.fetch,
      jobId,
      collection: "proposals",
      ...(cursor ? { cursor } : {}),
    });
    if (result.status !== "OK") {
      setNotice("Návrhy sa nepodarilo bezpečne načítať.");
      return false;
    }
    const next = result.value as MilestoneContextPage<MilestoneProposal>;
    if (cursor && page) {
      if (
        next.items.some((item) => page.items.some((old) => old.id === item.id))
      ) {
        setNotice("Ďalšie návrhy sa nepodarilo bezpečne načítať.");
        return false;
      }
      setPage({ ...next, items: [...page.items, ...next.items] });
    } else setPage(next);
    return true;
  };
  const run = async (key: string, action: MilestoneContextCommand) => {
    if (pending || !writable) return false;
    const intent = JSON.stringify(action);
    const prior = attempts.current.get(key);
    const id = prior?.intent === intent ? prior.id : crypto.randomUUID();
    attempts.current.set(key, { intent, id });
    setPending(true);
    setNotice("");
    const result = await sendMilestoneContextCommand({
      fetch: globalThis.fetch,
      jobId,
      commandId: id,
      command: action,
    });
    if (result.status === "OK") {
      attempts.current.delete(key);
      if (await load())
        setNotice(
          "Návrh a rozhodnutie sa zobrazujú podľa aktuálneho stavu. Nejde o zmenu prijatej ponuky.",
        );
    } else setNotice(commandError(result.status));
    setPending(false);
    return result.status === "OK";
  };
  const create = async () => {
    if (role !== "CUSTOMER" || !validDraft(title, description, start, end))
      return;
    const action: MilestoneContextCommand = {
      kind: "PROPOSAL",
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      plannedStartOn: start || null,
      plannedEndOn: end || null,
      targetMilestoneId: target || null,
    };
    if (await run("PROPOSAL", action)) {
      setTitle("");
      setDescription("");
      setStart("");
      setEnd("");
      setTarget("");
    }
  };
  const decision = (proposalId: string, value: "ACCEPT" | "DECLINE") => {
    if (role !== "PRIMARY_PROVIDER") return;
    void run(`DECISION:${proposalId}`, {
      kind: "DECISION",
      proposalId,
      decision: value,
    });
  };
  return (
    <section aria-labelledby="job-milestone-proposals">
      <h3 id="job-milestone-proposals">Návrhy zákazníka</h3>
      <p>
        Zákazník môže navrhnúť organizačný plán. Uplatní sa až rozhodnutím
        poskytovateľa; zmeny dohodnutej ceny, rozsahu alebo harmonogramu
        vyžadujú samostatnú zmenu objednávky.
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && page === null) void load();
        }}
      >
        {open ? "Skryť návrhy" : "Zobraziť návrhy"}
      </button>
      {open && (
        <div>
          {page ? (
            <MilestoneProposalItems
              items={page.items}
              jobId={jobId}
              pending={pending}
              {...(role === "PRIMARY_PROVIDER" ? { onDecision: decision } : {})}
            />
          ) : (
            <p role="status">Načítavajú sa návrhy…</p>
          )}
          {page?.nextCursor && (
            <button
              disabled={pending}
              type="button"
              onClick={() => void load(page.nextCursor!)}
            >
              Načítať staršie návrhy
            </button>
          )}
          {role === "CUSTOMER" && writable && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <h4>Navrhnúť míľnik alebo úpravu</h4>
              <label htmlFor="milestone-proposal-target">
                Týka sa míľnika (nepovinné)
              </label>
              <select
                id="milestone-proposal-target"
                disabled={pending}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">Nový míľnik</option>
                {milestones.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
              <label htmlFor="milestone-proposal-title">Navrhovaný názov</label>
              <input
                id="milestone-proposal-title"
                required
                maxLength={160}
                disabled={pending}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <label htmlFor="milestone-proposal-description">
                Opis (nepovinný)
              </label>
              <textarea
                id="milestone-proposal-description"
                maxLength={2000}
                disabled={pending}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <label htmlFor="milestone-proposal-start">
                Navrhovaný začiatok (nepovinný)
              </label>
              <input
                id="milestone-proposal-start"
                type="date"
                disabled={pending}
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
              <label htmlFor="milestone-proposal-end">
                Navrhovaný koniec (nepovinný)
              </label>
              <input
                id="milestone-proposal-end"
                type="date"
                disabled={pending}
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
              {start && end && start > end && (
                <p role="alert">Koniec musí byť v deň začiatku alebo neskôr.</p>
              )}
              <button
                type="submit"
                disabled={
                  pending || !validDraft(title, description, start, end)
                }
              >
                Poslať návrh
              </button>
            </form>
          )}
        </div>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}

export function MilestoneCommentItems({
  items,
}: {
  items: readonly MilestoneComment[];
}) {
  if (items.length === 0) return <p>Zatiaľ bez komentárov.</p>;
  return (
    <ol>
      {items.map((item) => (
        <li key={item.id}>
          <p>{item.body}</p>
          <p>
            {roleName[item.authorRole]} ·{" "}
            <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
          </p>
        </li>
      ))}
    </ol>
  );
}

export function JobMilestoneComments({
  jobId,
  milestoneId,
}: {
  jobId: string;
  milestoneId: string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] =
    useState<MilestoneContextPage<MilestoneComment> | null>(null);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ intent: string; id: string } | null>(null);
  useEffect(() => {
    setOpen(false);
    setPage(null);
    setBody("");
    setNotice("");
    retry.current = null;
  }, [jobId, milestoneId]);
  const load = async (cursor?: MilestoneContextCursor) => {
    const result = await loadMilestoneContextPage({
      fetch: globalThis.fetch,
      jobId,
      milestoneId,
      collection: "comments",
      ...(cursor ? { cursor } : {}),
    });
    if (result.status !== "OK") {
      setNotice("Komentáre sa nepodarilo bezpečne načítať.");
      return false;
    }
    const next = result.value as MilestoneContextPage<MilestoneComment>;
    if (cursor && page) {
      if (
        next.items.some((item) => page.items.some((old) => old.id === item.id))
      ) {
        setNotice("Ďalšie komentáre sa nepodarilo bezpečne načítať.");
        return false;
      }
      setPage({ ...next, items: [...page.items, ...next.items] });
    } else setPage(next);
    return true;
  };
  const submit = async () => {
    const intent = body.trim();
    if (!intent || intent.length > 2_000 || pending) return;
    const id =
      retry.current?.intent === intent ? retry.current.id : crypto.randomUUID();
    retry.current = { intent, id };
    setPending(true);
    setNotice("");
    const result = await sendMilestoneContextCommand({
      fetch: globalThis.fetch,
      jobId,
      commandId: id,
      command: { kind: "COMMENT", milestoneId, body: intent },
    });
    if (result.status === "OK") {
      retry.current = null;
      setBody("");
      if (await load())
        setNotice("Komentár bol pridaný do súkromnej histórie míľnika.");
    } else setNotice(commandError(result.status));
    setPending(false);
  };
  return (
    <section aria-labelledby="job-milestone-comments">
      <h2 id="job-milestone-comments">Komentáre k míľniku</h2>
      <p>
        Nesúhlas so stavom môžete vysvetliť tu. Komentár nemení stav ani prijatú
        ponuku.
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && page === null) void load();
        }}
      >
        {open ? "Skryť komentáre" : "Zobraziť komentáre"}
      </button>
      {open && (
        <div>
          {page ? (
            <MilestoneCommentItems items={page.items} />
          ) : (
            <p role="status">Načítavajú sa komentáre…</p>
          )}
          {page?.nextCursor && (
            <button
              disabled={pending}
              type="button"
              onClick={() => void load(page.nextCursor!)}
            >
              Načítať staršie komentáre
            </button>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="job-milestone-comment-body">Pridať komentár</label>
            <textarea
              id="job-milestone-comment-body"
              maxLength={2000}
              required
              disabled={pending}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <button
              disabled={pending || body.trim().length === 0}
              type="submit"
            >
              Pridať komentár
            </button>
          </form>
        </div>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}

export function MilestoneMediaItems({
  items,
}: {
  items: readonly MilestoneMedia[];
}) {
  if (items.length === 0) return <p>Zatiaľ bez pripojenej dokumentácie.</p>;
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          {item.kind === "PHOTO" && (
            <a href={item.downloadPath}>
              <img
                alt={item.displayFilename ?? "Fotografia míľnika"}
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
            Zo súkromnej dokumentácie zákazky · nahrané{" "}
            <time dateTime={item.uploadedAt}>{when(item.uploadedAt)}</time>
            {item.capturedAt && (
              <>
                {" "}
                · zachytené{" "}
                <time dateTime={item.capturedAt}>{when(item.capturedAt)}</time>
              </>
            )}
            · pripojené{" "}
            <time dateTime={item.linkedAt}>{when(item.linkedAt)}</time>
          </p>
        </li>
      ))}
    </ul>
  );
}

export function JobMilestoneMedia({
  jobId,
  milestoneId,
}: {
  jobId: string;
  milestoneId: string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<MilestoneContextPage<MilestoneMedia> | null>(
    null,
  );
  const [documents, setDocuments] = useState<JobDocumentPage | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const attempts = useRef(new Map<string, string>());
  useEffect(() => {
    setOpen(false);
    setPage(null);
    setDocuments(null);
    setNotice("");
    attempts.current.clear();
  }, [jobId, milestoneId]);
  const load = async (cursor?: MilestoneContextCursor) => {
    const result = await loadMilestoneContextPage({
      fetch: globalThis.fetch,
      jobId,
      milestoneId,
      collection: "media",
      ...(cursor ? { cursor } : {}),
    });
    if (result.status !== "OK") {
      setNotice("Dokumentáciu míľnika sa nepodarilo bezpečne načítať.");
      return false;
    }
    const next = result.value as MilestoneContextPage<MilestoneMedia>;
    if (cursor && page) {
      if (
        next.items.some((item) => page.items.some((old) => old.id === item.id))
      ) {
        setNotice("Ďalšiu dokumentáciu sa nepodarilo bezpečne načítať.");
        return false;
      }
      setPage({ ...next, items: [...page.items, ...next.items] });
    } else setPage(next);
    return true;
  };
  const loadDocuments = async (cursor?: JobDocumentPage["nextCursor"]) => {
    const next = await loadJobDocumentPage({
      fetch: globalThis.fetch,
      jobId,
      category: "ALL",
      ...(cursor ? { cursor } : {}),
    });
    if (!next) {
      setNotice(
        "Centrálnu dokumentáciu zákazky sa nepodarilo bezpečne načítať.",
      );
      return;
    }
    if (cursor && documents) {
      if (
        next.items.some((item) =>
          documents.items.some((old) => old.mediaAssetId === item.mediaAssetId),
        )
      ) {
        setNotice(
          "Ďalšiu centrálnu dokumentáciu sa nepodarilo bezpečne načítať.",
        );
        return;
      }
      setDocuments({ ...next, items: [...documents.items, ...next.items] });
    } else setDocuments(next);
  };
  const attach = async (mediaAssetId: string) => {
    if (
      pending ||
      !documents?.items.some((item) => item.mediaAssetId === mediaAssetId)
    )
      return;
    const id = attempts.current.get(mediaAssetId) ?? crypto.randomUUID();
    attempts.current.set(mediaAssetId, id);
    setPending(true);
    setNotice("");
    const result = await sendMilestoneContextCommand({
      fetch: globalThis.fetch,
      jobId,
      commandId: id,
      command: { kind: "MEDIA", milestoneId, mediaAssetId },
    });
    if (result.status === "OK") {
      attempts.current.delete(mediaAssetId);
      if (await load())
        setNotice(
          "Súbor je pripojený k míľniku a zostáva v centrálnej dokumentácii zákazky.",
        );
    } else setNotice(commandError(result.status));
    setPending(false);
  };
  return (
    <section aria-labelledby="job-milestone-media">
      <h2 id="job-milestone-media">Fotografie a dokumenty míľnika</h2>
      <p>
        Pripájajú sa iba už overené súkromné súbory tejto zákazky; pôvod
        nahratia zostáva zachovaný.
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && page === null) void load();
        }}
      >
        {open ? "Skryť dokumentáciu" : "Zobraziť dokumentáciu"}
      </button>
      {open && (
        <div>
          {page ? (
            <MilestoneMediaItems items={page.items} />
          ) : (
            <p role="status">Načítava sa dokumentácia míľnika…</p>
          )}
          {page?.nextCursor && (
            <button
              disabled={pending}
              type="button"
              onClick={() => void load(page.nextCursor!)}
            >
              Načítať ďalšie súbory míľnika
            </button>
          )}
          <button
            disabled={pending}
            type="button"
            onClick={() => void loadDocuments()}
          >
            Vybrať z centrálnej dokumentácie
          </button>
          {documents && (
            <div>
              <h3>Súkromné súbory zákazky</h3>
              {documents.items.length === 0 && (
                <p>
                  Najprv pridajte fotografiu alebo PDF do víťaznej konverzácie.
                </p>
              )}
              <ul>
                {documents.items.map((item) => (
                  <li key={item.mediaAssetId}>
                    {item.displayFilename ??
                      (item.kind === "PHOTO"
                        ? "Fotografia"
                        : "Dokument PDF")}{" "}
                    · {when(item.uploadedAt)}
                    <button
                      disabled={
                        pending ||
                        page?.items.some(
                          (linked) => linked.mediaAssetId === item.mediaAssetId,
                        )
                      }
                      type="button"
                      onClick={() => void attach(item.mediaAssetId)}
                    >
                      Pripojiť k míľniku
                    </button>
                  </li>
                ))}
              </ul>
              {documents.nextCursor && (
                <button
                  disabled={pending}
                  type="button"
                  onClick={() => void loadDocuments(documents.nextCursor)}
                >
                  Načítať ďalšie súbory zákazky
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}

export function JobMilestoneProposalDetail({
  jobId,
  proposalId,
}: {
  jobId: string;
  proposalId: string;
}) {
  const [proposal, setProposal] = useState<MilestoneProposal | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "ERROR" | "AUTH_REQUIRED"
  >("LOADING");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const attempts = useRef(new Map<"ACCEPT" | "DECLINE", string>());
  useEffect(() => {
    let active = true;
    setProposal(null);
    setStatus("LOADING");
    setNotice("");
    attempts.current.clear();
    void loadMilestoneProposal({
      fetch: globalThis.fetch,
      jobId,
      proposalId,
    }).then((result) => {
      if (!active) return;
      if (result.status === "OK") {
        setProposal(result.value);
        setStatus("OK");
      } else
        setStatus(
          result.status === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "ERROR",
        );
    });
    return () => {
      active = false;
    };
  }, [jobId, proposalId]);
  const decide = async (decision: "ACCEPT" | "DECLINE") => {
    if (!proposal?.canDecide || proposal.decision !== null || pending) return;
    const commandId = attempts.current.get(decision) ?? crypto.randomUUID();
    attempts.current.set(decision, commandId);
    setPending(true);
    setNotice("");
    const result = await sendMilestoneContextCommand({
      fetch: globalThis.fetch,
      jobId,
      commandId,
      command: { kind: "DECISION", proposalId, decision },
    });
    if (result.status === "OK") {
      attempts.current.delete(decision);
      const refreshed = await loadMilestoneProposal({
        fetch: globalThis.fetch,
        jobId,
        proposalId,
      });
      if (refreshed.status === "OK") {
        setProposal(refreshed.value);
        setNotice(
          "Rozhodnutie bolo potvrdené. Prijatá ponuka zostáva nezmenená.",
        );
      } else
        setNotice("Rozhodnutie sa potvrdilo, ale návrh sa nepodarilo obnoviť.");
    } else setNotice(commandError(result.status));
    setPending(false);
  };
  if (status === "LOADING")
    return <p role="status">Načítava sa súkromný návrh…</p>;
  if (status === "AUTH_REQUIRED")
    return <p role="alert">Najprv sa prihláste.</p>;
  if (status !== "OK" || !proposal)
    return <p role="alert">Návrh nie je dostupný.</p>;
  return (
    <article className="job-milestone-proposal-detail">
      <p>
        <Link href={`/zakazky/${jobId}`}>Späť na zákazku</Link>
      </p>
      <h1>{proposal.title}</h1>
      <p>
        {proposal.targetMilestoneId
          ? "Návrh na úpravu míľnika"
          : "Návrh nového míľnika"}
      </p>
      {proposal.description && <p>{proposal.description}</p>}
      <p>
        Navrhovaný prevádzkový plán:{" "}
        {plan(proposal.plannedStartOn, proposal.plannedEndOn)}
      </p>
      <p>
        Navrhnuté{" "}
        <time dateTime={proposal.createdAt}>{when(proposal.createdAt)}</time>
      </p>
      {proposal.decision === null ? (
        <p>Čaká na rozhodnutie poskytovateľa.</p>
      ) : (
        <p>
          {proposal.decision === "ACCEPT" ? "Prijaté" : "Odmietnuté"}
          {proposal.decidedAt && (
            <>
              {" "}
              ·{" "}
              <time dateTime={proposal.decidedAt}>
                {when(proposal.decidedAt)}
              </time>
            </>
          )}
        </p>
      )}
      {proposal.appliedMilestoneId && (
        <p>
          <Link
            href={`/zakazky/${jobId}/milniky/${proposal.appliedMilestoneId}`}
          >
            Otvoriť výsledný míľnik
          </Link>
        </p>
      )}
      {proposal.canDecide && proposal.decision === null && (
        <div>
          <button
            disabled={pending}
            type="button"
            onClick={() => void decide("ACCEPT")}
          >
            Prijať prevádzkový návrh
          </button>
          <button
            disabled={pending}
            type="button"
            onClick={() => void decide("DECLINE")}
          >
            Odmietnuť návrh
          </button>
        </div>
      )}
      <p>
        Rozhodnutie o organizačnom míľniku nemení cenu, rozsah ani dohodnutý
        harmonogram.
      </p>
      {notice && <p role="alert">{notice}</p>}
    </article>
  );
}
