"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  ADMIN_DISPUTE_STATES,
  accessAdminDispute,
  createAdminCommandId,
  loadAdminDisputeQueue,
  sendAdminDisputeCommand,
  sendAdminJobCorrection,
  type AdminCommandResult,
  type AdminDisputeDetail,
  type AdminDisputeQueueItem,
  type AdminDisputeState,
} from "./admin-operations-data";

const STATE_LABEL: Record<AdminDisputeState, string> = {
  OPEN: "Otvorený",
  WAITING_FOR_PARTY: "Čaká na stranu",
  UNDER_REVIEW: "Preveruje sa",
  RESOLVED: "Vyriešený",
  CLOSED: "Uzavretý",
};

type QueueState =
  | { status: "LOADING" }
  | { status: "ERROR" }
  | { status: "READY"; items: readonly AdminDisputeQueueItem[] };

export function AdminDisputeWorkspace() {
  const [filter, setFilter] = useState<AdminDisputeState | "ALL">("ALL");
  const [queue, setQueue] = useState<QueueState>({ status: "LOADING" });
  const [detail, setDetail] = useState<AdminDisputeDetail | null>(null);
  const [accessReason, setAccessReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const retry = useRef<{ fingerprint: string; commandId: string } | null>(null);

  const reload = useCallback(async () => {
    setQueue({ status: "LOADING" });
    const result = await loadAdminDisputeQueue(
      fetch,
      filter === "ALL" ? undefined : filter,
    );
    setQueue(
      result.status === "OK"
        ? { status: "READY", items: result.value }
        : { status: "ERROR" },
    );
  }, [filter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openCase(disputeId: string) {
    if (accessReason.trim().length < 8) {
      setMessage("Uveďte konkrétny interný dôvod prístupu (aspoň 8 znakov). ");
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await accessAdminDispute(fetch, {
      disputeId,
      accessId: createAdminCommandId(),
      reason: accessReason.trim(),
    });
    setBusy(false);
    if (result.status === "OK") {
      setDetail(result.value);
      setMessage("Citlivý prístup bol zapísaný do auditu.");
    } else {
      setMessage(readFailure(result.status));
    }
  }

  async function execute(
    reason: string,
    command: Parameters<typeof sendAdminDisputeCommand>[1]["command"],
  ) {
    if (!detail) return;
    const fingerprint = JSON.stringify({
      disputeId: detail.disputeId,
      expectedState: detail.state,
      reason,
      command,
    });
    if (retry.current?.fingerprint !== fingerprint) {
      retry.current = { fingerprint, commandId: createAdminCommandId() };
    }
    setBusy(true);
    setMessage(null);
    const result = await sendAdminDisputeCommand(fetch, {
      disputeId: detail.disputeId,
      commandId: retry.current.commandId,
      expectedState: detail.state,
      reason,
      command,
    });
    setBusy(false);
    if (result.status === "OK") {
      retry.current = null;
      setMessage(
        result.outcome === "DEDUPLICATED"
          ? "Príkaz už bol bezpečne vykonaný."
          : "Administrátorská akcia bola vykonaná a auditovaná.",
      );
      await reload();
      const refreshed = await accessAdminDispute(fetch, {
        disputeId: detail.disputeId,
        accessId: createAdminCommandId(),
        reason: "Obnovenie prípadu po vykonanej administrátorskej akcii.",
      });
      if (refreshed.status === "OK") setDetail(refreshed.value);
    } else {
      setMessage(commandFailure(result));
    }
  }

  return (
    <section
      className="admin-panel admin-operations"
      aria-labelledby="admin-disputes-title"
    >
      <p className="admin-kicker">Auditovaná prevádzková fronta</p>
      <h2 id="admin-disputes-title">Sporné prípady</h2>
      <p>
        Každý prístup ku komunikácii vyžaduje dôvod. Výsledok je iba prevádzkové
        riešenie platformy; nemení zmluvu, peniaze ani právne nároky strán.
      </p>
      <div className="admin-toolbar">
        <label>
          Stav
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as AdminDisputeState | "ALL");
              setDetail(null);
            }}
          >
            <option value="ALL">Všetky stavy</option>
            {ADMIN_DISPUTE_STATES.map((state) => (
              <option key={state} value={state}>
                {STATE_LABEL[state]}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-grow">
          Dôvod prístupu k citlivým údajom
          <input
            maxLength={500}
            minLength={8}
            onChange={(event) => setAccessReason(event.target.value)}
            placeholder="Napr. preverenie komunikácie k otvorenému prípadu"
            value={accessReason}
          />
        </label>
      </div>
      {message && (
        <p className="admin-status" role="status">
          {message}
        </p>
      )}
      {queue.status === "LOADING" ? (
        <p role="status">Načítavam frontu…</p>
      ) : queue.status === "ERROR" ? (
        <div className="admin-empty-state" role="alert">
          <strong>Frontu sa nepodarilo bezpečne načítať.</strong>
          <button type="button" onClick={() => void reload()}>
            Skúsiť znova
          </button>
        </div>
      ) : queue.items.length === 0 ? (
        <div className="admin-empty-state" role="status">
          <strong>Pre zvolený filter nie sú prípady.</strong>
        </div>
      ) : (
        <ul className="admin-case-list">
          {queue.items.map((item) => (
            <li
              key={item.disputeId}
              aria-current={
                detail?.disputeId === item.disputeId ? "true" : undefined
              }
            >
              <div>
                <strong>
                  {STATE_LABEL[item.state]} · {item.category}
                </strong>
                <span>
                  Zákazka {shortId(item.jobId)} · otvoril{" "}
                  {role(item.openedByRole)}
                </span>
                <small>
                  {dateTime(item.stateChangedAt)} · požiadavky:{" "}
                  {item.informationRequestCount}
                </small>
              </div>
              <button
                disabled={busy}
                type="button"
                onClick={() => void openCase(item.disputeId)}
              >
                Auditovane otvoriť
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <AdminDisputeCase detail={detail} disabled={busy} execute={execute} />
      )}
    </section>
  );
}

function AdminDisputeCase({
  detail,
  disabled,
  execute,
}: Readonly<{
  detail: AdminDisputeDetail;
  disabled: boolean;
  execute: (
    reason: string,
    command: Parameters<typeof sendAdminDisputeCommand>[1]["command"],
  ) => Promise<void>;
}>) {
  const [reason, setReason] = useState("");
  const [requestText, setRequestText] = useState("");
  const [recipient, setRecipient] = useState<
    "CUSTOMER" | "PRIMARY_PROVIDER" | "BOTH"
  >("BOTH");
  const [deadline, setDeadline] = useState("");
  const [note, setNote] = useState("");
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<
    | "RESOLVED_BY_PARTIES"
    | "OPERATIONAL_ADMIN_RESOLUTION"
    | "NO_ACTION"
    | "REFERRED_OUTSIDE_PLATFORM"
    | "ACCOUNT_POLICY_ACTION"
    | "OTHER"
  >("OPERATIONAL_ADMIN_RESOLUTION");
  const [basis, setBasis] = useState<
    "MUTUAL_PARTY_AGREEMENT" | "ADMINISTRATIVE_CLOSURE"
  >("ADMINISTRATIVE_CLOSURE");

  const submit = (command: Parameters<typeof execute>[1]) => {
    const safeReason = reason.trim();
    if (safeReason.length < 8) return;
    void execute(safeReason, command);
  };

  return (
    <div className="admin-case-detail">
      <header>
        <div>
          <p className="admin-kicker">Prípad {shortId(detail.disputeId)}</p>
          <h3>
            {STATE_LABEL[detail.state]} · {detail.category}
          </h3>
        </div>
        <span className="admin-state-badge">Job: {detail.jobState}</span>
      </header>
      <dl className="admin-facts">
        <div>
          <dt>Opis</dt>
          <dd>{detail.description}</dd>
        </div>
        <div>
          <dt>Želané riešenie</dt>
          <dd>{detail.desiredResolution}</dd>
        </div>
      </dl>
      <label className="admin-reason">
        Interný auditný dôvod každej nasledujúcej akcie
        <textarea
          minLength={8}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="admin-action-grid">
        {(detail.state === "OPEN" || detail.state === "WAITING_FOR_PARTY") && (
          <Action
            title="Začať preverovanie"
            warning="Presunie prípad do stavu preverovania."
          >
            <button
              disabled={disabled || reason.trim().length < 8}
              type="button"
              onClick={() => submit({ action: "START_REVIEW" })}
            >
              Začať preverovanie
            </button>
          </Action>
        )}
        {detail.state === "CLOSED" && (
          <Action
            title="Znovu otvoriť"
            warning="Vyžaduje nový zdokumentovaný dôvod."
          >
            <button
              disabled={disabled || reason.trim().length < 8}
              type="button"
              onClick={() => submit({ action: "REOPEN" })}
            >
              Znovu otvoriť
            </button>
          </Action>
        )}
        {detail.state === "RESOLVED" && (
          <Action
            title="Uzavrieť prípad"
            warning="Uzavretie nemení obchodnú dohodu ani právne nároky."
          >
            <button
              disabled={disabled || reason.trim().length < 8}
              type="button"
              onClick={() => submit({ action: "CLOSE" })}
            >
              Uzavrieť prípad
            </button>
          </Action>
        )}
        {!(["RESOLVED", "CLOSED"] as string[]).includes(detail.state) && (
          <Action
            title="Vyžiadať informácie"
            warning="Termín je prevádzkový; jeho zmeškanie nespôsobuje právnu stratu."
          >
            <label>
              Adresát
              <select
                value={recipient}
                onChange={(event) =>
                  setRecipient(event.target.value as typeof recipient)
                }
              >
                <option value="BOTH">Obe strany</option>
                <option value="CUSTOMER">Zákazník</option>
                <option value="PRIMARY_PROVIDER">Hlavný remeselník</option>
              </select>
            </label>
            <label>
              Požiadavka
              <textarea
                maxLength={2000}
                value={requestText}
                onChange={(event) => setRequestText(event.target.value)}
              />
            </label>
            <label>
              Termín (voliteľný)
              <input
                type="datetime-local"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
              />
            </label>
            <button
              disabled={
                disabled ||
                reason.trim().length < 8 ||
                requestText.trim().length === 0
              }
              type="button"
              onClick={() =>
                submit({
                  action: "REQUEST_INFORMATION",
                  recipient,
                  requestText: requestText.trim(),
                  replyDeadline:
                    deadline === "" ? null : new Date(deadline).toISOString(),
                })
              }
            >
              Odoslať požiadavku
            </button>
          </Action>
        )}
        <Action
          title="Súkromná interná poznámka"
          warning="Nikdy sa nezobrazuje stranám prípadu."
        >
          <textarea
            maxLength={4000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            disabled={
              disabled || reason.trim().length < 8 || note.trim().length === 0
            }
            type="button"
            onClick={() =>
              submit({ action: "ADD_INTERNAL_NOTE", note: note.trim() })
            }
          >
            Pridať internú poznámku
          </button>
        </Action>
        {!(["RESOLVED", "CLOSED"] as string[]).includes(detail.state) && (
          <Action
            title="Zaznamenať výsledok"
            warning="Ide o prevádzkové odporúčanie platformy, nie právny verdikt, refundáciu ani zmenu dohody."
          >
            <label>
              Kategória
              <select
                value={category}
                onChange={(event) =>
                  setCategory(event.target.value as typeof category)
                }
              >
                <option value="OPERATIONAL_ADMIN_RESOLUTION">
                  Prevádzkové riešenie
                </option>
                <option value="RESOLVED_BY_PARTIES">Vyriešené stranami</option>
                <option value="NO_ACTION">Bez ďalšej akcie</option>
                <option value="REFERRED_OUTSIDE_PLATFORM">
                  Odkázané mimo platformy
                </option>
                <option value="ACCOUNT_POLICY_ACTION">
                  Samostatné opatrenie účtu
                </option>
                <option value="OTHER">Iné</option>
              </select>
            </label>
            <label>
              Podklad
              <select
                value={basis}
                onChange={(event) =>
                  setBasis(event.target.value as typeof basis)
                }
              >
                <option value="ADMINISTRATIVE_CLOSURE">
                  Administratívne uzavretie
                </option>
                <option value="MUTUAL_PARTY_AGREEMENT">
                  Vzájomná dohoda strán
                </option>
              </select>
            </label>
            <label>
              Zhrnutie
              <textarea
                maxLength={4000}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </label>
            <button
              disabled={
                disabled ||
                reason.trim().length < 8 ||
                summary.trim().length === 0
              }
              type="button"
              onClick={() =>
                submit({
                  action: "RECORD_OUTCOME",
                  category,
                  basis,
                  summary: summary.trim(),
                })
              }
            >
              Zaznamenať výsledok
            </button>
          </Action>
        )}
      </div>
      <CaseEvidence detail={detail} />
    </div>
  );
}

function CaseEvidence({ detail }: Readonly<{ detail: AdminDisputeDetail }>) {
  return (
    <div className="admin-evidence-grid">
      <article>
        <h4>Vyjadrenia strán</h4>
        {detail.statements.length === 0 ? (
          <p>Bez vyjadrení.</p>
        ) : (
          <ol>
            {detail.statements.map((item) => (
              <li key={item.id}>
                <strong>{role(item.authorRole)}</strong>
                <p>{item.body}</p>
                <small>{dateTime(item.createdAt)}</small>
              </li>
            ))}
          </ol>
        )}
      </article>
      <article>
        <h4>Požiadavky administrátora</h4>
        {detail.informationRequests.length === 0 ? (
          <p>Bez požiadaviek.</p>
        ) : (
          <ol>
            {detail.informationRequests.map((item) => (
              <li key={item.id}>
                <strong>{role(item.recipient)}</strong>
                <p>{item.requestText}</p>
                <small>
                  {dateTime(item.requestedAt)}
                  {item.replyDeadline
                    ? ` · termín ${dateTime(item.replyDeadline)}`
                    : ""}
                </small>
              </li>
            ))}
          </ol>
        )}
      </article>
      <article>
        <h4>Interné poznámky</h4>
        {detail.internalNotes.length === 0 ? (
          <p>Bez poznámok.</p>
        ) : (
          <ol>
            {detail.internalNotes.map((item) => (
              <li key={item.id}>
                <p>{item.body}</p>
                <small>{dateTime(item.createdAt)}</small>
              </li>
            ))}
          </ol>
        )}
      </article>
      <article>
        <h4>Výsledky</h4>
        {detail.outcomes.length === 0 ? (
          <p>Výsledok zatiaľ nebol zaznamenaný.</p>
        ) : (
          <ol>
            {detail.outcomes.map((item) => (
              <li key={item.id}>
                <strong>{item.category}</strong>
                <p>{item.summary}</p>
                <small>
                  {item.basis} · {dateTime(item.recordedAt)}
                </small>
              </li>
            ))}
          </ol>
        )}
      </article>
      <article className="admin-wide">
        <h4>Relevantná komunikácia</h4>
        <p>
          {detail.conversation.length} záznamov · {detail.attachments.length}{" "}
          príloh · {detail.evidence.length} dôkazov prípadu
        </p>
        {detail.conversation.length > 0 && (
          <ol>
            {detail.conversation.map((item) => (
              <li key={item.id}>
                <strong>
                  #{item.sequence} · {item.kind}
                </strong>
                {item.body && <p>{item.body}</p>}
                <small>{dateTime(item.createdAt)}</small>
              </li>
            ))}
          </ol>
        )}
      </article>
    </div>
  );
}

function Action({
  title,
  warning,
  children,
}: Readonly<{ title: string; warning: string; children: ReactNode }>) {
  return (
    <form className="admin-action" onSubmit={(event) => event.preventDefault()}>
      <h4>{title}</h4>
      <p>{warning}</p>
      {children}
    </form>
  );
}

export function AdminJobOperations() {
  return (
    <section
      className="admin-panel admin-operations"
      aria-labelledby="admin-jobs-title"
    >
      <p className="admin-kicker">Citlivé výnimočné príkazy</p>
      <h2 id="admin-jobs-title">Zákazky</h2>
      <p>
        Nie je tu generické nastavenie stavu. Každá oprava je samostatný,
        nedeliteľný a auditovaný príkaz s očakávaným aktuálnym stavom.
      </p>
      <div className="admin-action-grid">
        <AdminJobCorrectionForm kind="COMPLETE" />
        <AdminJobCorrectionForm kind="CANCEL" />
      </div>
    </section>
  );
}

function AdminJobCorrectionForm({
  kind,
}: Readonly<{ kind: "COMPLETE" | "CANCEL" }>) {
  const [jobId, setJobId] = useState("");
  const [expectedState, setExpectedState] = useState<
    "CONFIRMED" | "IN_PROGRESS" | "COMPLETION_REQUESTED"
  >(kind === "COMPLETE" ? "IN_PROGRESS" : "CONFIRMED");
  const [reason, setReason] = useState("");
  const [userFacingReason, setUserFacingReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const retry = useRef<{ fingerprint: string; commandId: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = {
      jobId: jobId.trim(),
      expectedState,
      reason: reason.trim(),
      userFacingReason: userFacingReason.trim(),
    };
    const fingerprint = JSON.stringify({ kind, ...normalized });
    if (retry.current?.fingerprint !== fingerprint)
      retry.current = { fingerprint, commandId: createAdminCommandId() };
    setBusy(true);
    setMessage(null);
    const result =
      kind === "COMPLETE"
        ? await sendAdminJobCorrection(fetch, {
            kind,
            commandId: retry.current.commandId,
            jobId: normalized.jobId,
            expectedState: expectedState as
              "IN_PROGRESS" | "COMPLETION_REQUESTED",
            reason: normalized.reason,
          })
        : await sendAdminJobCorrection(fetch, {
            kind,
            commandId: retry.current.commandId,
            jobId: normalized.jobId,
            expectedState,
            reason: normalized.reason,
            userFacingReason: normalized.userFacingReason,
          });
    setBusy(false);
    if (result.status === "OK") {
      retry.current = null;
      setMessage(
        result.outcome === "APPLIED"
          ? `Zákazka bola ${kind === "COMPLETE" ? "výnimočne dokončená" : "výnimočne zrušená"}.`
          : "Príkaz už bol bezpečne vykonaný.",
      );
      setConfirmed(false);
    } else setMessage(commandFailure(result));
  }

  return (
    <form className="admin-action" onSubmit={(event) => void submit(event)}>
      <h3>{kind === "COMPLETE" ? "Výnimočne dokončiť" : "Výnimočne zrušiť"}</h3>
      <p>
        {kind === "COMPLETE"
          ? "Nenahrádza akceptáciu zákazníka a je v histórii jasne odlíšené."
          : "Samostatný používateľský dôvod sa zobrazí stranám; interný dôvod ostáva iba v audite."}
      </p>
      <label>
        ID zákazky
        <input
          required
          pattern="[0-9a-fA-F-]{36}"
          value={jobId}
          onChange={(event) => setJobId(event.target.value)}
        />
      </label>
      <label>
        Očakávaný aktuálny stav
        <select
          value={expectedState}
          onChange={(event) =>
            setExpectedState(event.target.value as typeof expectedState)
          }
        >
          {kind === "CANCEL" && <option value="CONFIRMED">Potvrdená</option>}
          <option value="IN_PROGRESS">Prebieha</option>
          <option value="COMPLETION_REQUESTED">
            Čaká na potvrdenie dokončenia
          </option>
        </select>
      </label>
      <label>
        Interný auditný dôvod
        <textarea
          required
          minLength={8}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {kind === "CANCEL" && (
        <label>
          Dôvod viditeľný stranám
          <textarea
            required
            minLength={8}
            maxLength={1000}
            value={userFacingReason}
            onChange={(event) => setUserFacingReason(event.target.value)}
          />
        </label>
      )}
      <label className="admin-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        Overil(a) som ID, aktuálny stav a dôvod výnimočného zásahu.
      </label>
      <button disabled={busy || !confirmed} type="submit">
        {busy
          ? "Zapisujem…"
          : kind === "COMPLETE"
            ? "Výnimočne dokončiť"
            : "Výnimočne zrušiť"}
      </button>
      {message && (
        <p className="admin-status" role="status">
          {message}
        </p>
      )}
    </form>
  );
}

function commandFailure(result: AdminCommandResult): string {
  if (result.status === "STALE_STATE")
    return "Stav sa medzitým zmenil. Obnovte údaje a rozhodnite znova.";
  if (result.status === "CONFLICT")
    return "Identifikátor príkazu bol použitý s iným obsahom.";
  return readFailure(result.status);
}
function readFailure(status: string): string {
  if (status === "AUTH_REQUIRED")
    return "Prihlásenie alebo MFA relácia už nie je platná.";
  if (status === "ACCESS_DENIED")
    return "Server odmietol privilegovaný prístup.";
  if (status === "NOT_FOUND")
    return "Záznam neexistuje alebo k nemu nemáte prístup.";
  return "Operáciu sa nepodarilo bezpečne dokončiť.";
}
function shortId(value: string): string {
  return value.slice(0, 8);
}
function role(value: string): string {
  return (
    (
      {
        CUSTOMER: "zákazník",
        PRIMARY_PROVIDER: "hlavný remeselník",
        BOTH: "obe strany",
      } as Record<string, string>
    )[value] ?? value
  );
}
function dateTime(value: string): string {
  return new Intl.DateTimeFormat("sk-SK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
