"use client";

import React, { useEffect, useRef, useState } from "react";

import { loadJobDocumentPage, type JobDocumentItem } from "./job-documentation";
import { loadMilestonePage } from "./job-milestone-data";
import { loadJobRosterPage } from "./job-roster";
import {
  loadCompletionPage,
  sendCompletionCommand,
  type CompletionCategory,
  type CompletionCommand,
  type CompletionPage,
  type CompletionState,
} from "./job-completion-data";
import {
  loadCustomerCompletionProposals,
  sendCustomerCompletionProposalCommand,
  type CustomerCompletionProposalCommand,
  type ProposalLoad,
} from "./customer-completion-proposal-data";

const categoryName: Record<CompletionCategory, string> = {
  UNFINISHED_SCOPE: "Nedokončený rozsah",
  DEFECT: "Vada alebo problém",
  MISSING_OUTPUT: "Chýbajúci dokument alebo výstup",
  OTHER: "Iné",
};
const outcomeName = {
  PENDING: "Čaká na rozhodnutie zákazníka",
  ACCEPTED: "Dokončenie potvrdené",
  REJECTED: "Dokončenie odmietnuté",
  WITHDRAWN: "Žiadosť stiahnutá",
} as const;
const dateTime = (value: string) => new Date(value).toLocaleString("sk-SK");

export function JobCompletion({
  jobId,
  role,
  jobState,
}: {
  jobId: string;
  role: "CUSTOMER" | "PRIMARY_PROVIDER";
  jobState: CompletionState;
}) {
  const [page, setPage] = useState<CompletionPage | null>(null);
  const [proposalLoad, setProposalLoad] = useState<ProposalLoad | null>(null);
  const [status, setStatus] = useState<"LOADING" | "OK" | "ERROR">("LOADING");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [note, setNote] = useState("");
  const [finishedOn, setFinishedOn] = useState("");
  const [reason, setReason] = useState("");
  const [proposalNote, setProposalNote] = useState("");
  const [proposalReason, setProposalReason] = useState("");
  const [category, setCategory] =
    useState<CompletionCategory>("UNFINISHED_SCOPE");
  const [media, setMedia] = useState<readonly JobDocumentItem[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<readonly string[]>([]);
  const [milestoneWarning, setMilestoneWarning] = useState("");
  const [rosterWarning, setRosterWarning] = useState("");
  const retries = useRef(
    new Map<string, { intent: string; commandId: string }>(),
  );
  useEffect(() => {
    let active = true;
    setStatus("LOADING");
    void loadCompletionPage({ fetch: globalThis.fetch, jobId }).then(
      (result) => {
        if (!active) return;
        if (result.status === "OK") {
          setPage(result.page);
          setStatus("OK");
        } else {
          setStatus("ERROR");
        }
      },
    );
    void loadCustomerCompletionProposals({
      fetch: globalThis.fetch,
      jobId,
    }).then((result) => {
      if (active) setProposalLoad(result);
    });
    if (jobState === "IN_PROGRESS" || jobState === "COMPLETION_REQUESTED") {
      void loadJobDocumentPage({
        fetch: globalThis.fetch,
        jobId,
        category: "ALL",
      }).then((result) => {
        if (active && result) setMedia(result.items);
      });
    }
    if (jobState === "IN_PROGRESS" && role === "PRIMARY_PROVIDER") {
      void loadMilestonePage({ fetch: globalThis.fetch, jobId }).then(
        (result) => {
          if (!active) return;
          if (result.status !== "OK") {
            setMilestoneWarning(
              "Stav míľnikov sa nepodarilo overiť. Skontrolujte plán pred odoslaním.",
            );
            return;
          }
          const unfinished = result.value.items.filter(
            (item) =>
              (item.acceptedStageLabel !== null ||
                item.sourceChangeOrderRevisionId !== null) &&
              (item.state === "PLANNED" || item.state === "IN_PROGRESS"),
          );
          if (unfinished.length > 0)
            setMilestoneWarning(
              `${unfinished.length} míľnik(ov) naviazaných na obchodný rozsah ešte nie je dokončených. Skontrolujte ich pred odoslaním.`,
            );
          else if (result.value.nextCursor)
            setMilestoneWarning(
              "Existujú ďalšie míľniky mimo zobrazeného prehľadu. Skontrolujte ich pred odoslaním.",
            );
        },
      );
      void loadJobRosterPage({ fetch: globalThis.fetch, jobId }).then(
        (result) => {
          if (!active) return;
          if (
            result?.participants.some(
              (participant) => participant.state === "INVITED",
            )
          )
            setRosterWarning(
              "Niektorí pozvaní účastníci ešte nepotvrdili účasť; nemajú overenú účasť na dokončenej zákazke.",
            );
          else if (result?.nextCursor)
            setRosterWarning(
              "Zoznam účastníkov má ďalšiu stranu. Pred dokončením skontrolujte celý tím.",
            );
          else if (!result)
            setRosterWarning(
              "Zoznam účastníkov sa nepodarilo overiť. Skontrolujte ho pred odoslaním.",
            );
        },
      );
    }
    return () => {
      active = false;
    };
  }, [jobId, jobState, role]);

  const submit = async (key: string, command: CompletionCommand) => {
    if (pending) return;
    const intent = JSON.stringify(command);
    const previous = retries.current.get(key);
    const commandId =
      previous?.intent === intent ? previous.commandId : crypto.randomUUID();
    retries.current.set(key, { intent, commandId });
    setPending(true);
    setNotice("");
    const result = await sendCompletionCommand({
      fetch: globalThis.fetch,
      jobId,
      commandId,
      command,
    });
    if (result.status === "OK") {
      retries.current.delete(key);
      const refreshed = await loadCompletionPage({
        fetch: globalThis.fetch,
        jobId,
      });
      if (refreshed.status === "OK") setPage(refreshed.page);
      setNotice(
        "Rozhodnutie je uložené v histórii. Obnovujeme aktuálny stav zákazky.",
      );
      window.location.reload();
    } else {
      setNotice(
        result.status === "CONFLICT"
          ? "Stav sa zmenil. Obnovte stránku a skontrolujte aktuálny pokus."
          : result.status === "AUTH_REQUIRED"
            ? "Relácia sa skončila. Prihláste sa znova."
            : "Výsledok sa nepodarilo potvrdiť. Zopakujte nezmenenú akciu alebo obnovte stránku.",
      );
    }
    setPending(false);
  };
  const submitProposal = async (
    key: string,
    command: CustomerCompletionProposalCommand,
  ) => {
    if (pending) return;
    const intent = JSON.stringify(command);
    const previous = retries.current.get(key);
    const commandId =
      previous?.intent === intent ? previous.commandId : crypto.randomUUID();
    retries.current.set(key, { intent, commandId });
    setPending(true);
    setNotice("");
    const result = await sendCustomerCompletionProposalCommand({
      fetch: globalThis.fetch,
      jobId,
      commandId,
      command,
    });
    if (result.status === "OK") {
      retries.current.delete(key);
      setNotice("Návrh a rozhodnutie sú uložené v histórii.");
      window.location.reload();
    } else {
      setNotice(
        result.status === "CONFLICT"
          ? "Návrh sa medzitým zmenil. Obnovte stránku."
          : result.status === "AUTH_REQUIRED"
            ? "Relácia sa skončila. Prihláste sa znova."
            : "Výsledok návrhu sa nepodarilo potvrdiť. Zopakujte nezmenenú akciu.",
      );
    }
    setPending(false);
  };
  const toggleMedia = (id: string) =>
    setSelectedMedia((ids) =>
      ids.includes(id)
        ? ids.filter((old) => old !== id)
        : ids.length < 10
          ? [...ids, id]
          : ids,
    );
  const latest = page?.attempts[0];
  const latestProposal =
    proposalLoad?.status === "OK" ? proposalLoad.proposals[0] : undefined;
  const proposalPending = latestProposal?.outcome === "PENDING";
  return (
    <section aria-labelledby="job-completion-heading">
      <h2 id="job-completion-heading">Dokončenie zákazky</h2>
      <p>
        Dokončenie potvrdzuje odovzdanie práce, nie platbu, recenziu ani súhlas
        so zverejnením fotografií.
      </p>
      {status === "LOADING" && (
        <p role="status">Načítava sa história dokončenia…</p>
      )}
      {status === "ERROR" && (
        <p role="alert">Históriu dokončenia sa nepodarilo bezpečne načítať.</p>
      )}
      {status === "OK" && page && (
        <>
          {page.administrativeCompletion && (
            <div role="status">
              <h3>Výnimočné administrátorské dokončenie</h3>
              <p>
                Zákazka bola uzavretá administrátorským zásahom, nie potvrdením
                zákazníka. Zásah je samostatne zaznamenaný v audite.
              </p>
              <p>Dôvod: {page.administrativeCompletion.reason}</p>
              <time dateTime={page.administrativeCompletion.recordedAt}>
                {dateTime(page.administrativeCompletion.recordedAt)}
              </time>
            </div>
          )}
          <section aria-labelledby="customer-completion-proposal-heading">
            <h3 id="customer-completion-proposal-heading">
              Návrh dokončenia od zákazníka
            </h3>
            <p>
              Návrh zákazníka sám zákazku nedokončí. Poskytovateľ musí výslovne
              rozhodnúť a následne podať bežnú žiadosť o odovzdanie.
            </p>
            {proposalLoad === null && (
              <p role="status">Načítavajú sa zákaznícke návrhy…</p>
            )}
            {proposalLoad !== null && proposalLoad.status !== "OK" && (
              <p role="alert">
                Zákaznícke návrhy sa nepodarilo bezpečne načítať.
              </p>
            )}
            {proposalLoad?.status === "OK" && (
              <>
                {jobState === "IN_PROGRESS" &&
                  role === "CUSTOMER" &&
                  !proposalPending && (
                    <div>
                      <label htmlFor="customer-completion-proposal-note">
                        Prečo podľa vás možno prácu uzavrieť? (nepovinné)
                      </label>
                      <textarea
                        id="customer-completion-proposal-note"
                        maxLength={1000}
                        disabled={pending}
                        value={proposalNote}
                        onChange={(event) =>
                          setProposalNote(event.target.value)
                        }
                      />
                      <button
                        type="button"
                        disabled={pending || proposalNote.length > 1000}
                        onClick={() =>
                          void submitProposal("PROPOSE", {
                            kind: "PROPOSE",
                            ...(proposalNote.trim()
                              ? { note: proposalNote.trim() }
                              : {}),
                          })
                        }
                      >
                        Navrhnúť dokončenie
                      </button>
                    </div>
                  )}
                {jobState === "IN_PROGRESS" &&
                  role === "PRIMARY_PROVIDER" &&
                  proposalPending &&
                  latestProposal && (
                    <div>
                      <p>
                        Zákazník navrhol dokončenie. Súhlas nie je žiadosť o
                        potvrdenie dokončenia; po súhlase ešte odošlite
                        záverečné odovzdanie.
                      </p>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void submitProposal(`AGREE:${latestProposal.id}`, {
                            kind: "AGREE",
                            proposalId: latestProposal.id,
                          })
                        }
                      >
                        Súhlasím, práca je hotová
                      </button>
                      <label htmlFor="customer-completion-disagree-reason">
                        Ak práca pokračuje, uveďte dôvod
                      </label>
                      <textarea
                        id="customer-completion-disagree-reason"
                        minLength={8}
                        maxLength={1000}
                        disabled={pending}
                        value={proposalReason}
                        onChange={(event) =>
                          setProposalReason(event.target.value)
                        }
                      />
                      <button
                        type="button"
                        disabled={
                          pending ||
                          proposalReason.trim().length < 8 ||
                          proposalReason.length > 1000
                        }
                        onClick={() =>
                          void submitProposal(`DISAGREE:${latestProposal.id}`, {
                            kind: "DISAGREE",
                            proposalId: latestProposal.id,
                            reason: proposalReason.trim(),
                          })
                        }
                      >
                        Nesúhlasím, práca pokračuje
                      </button>
                    </div>
                  )}
                {proposalPending && role === "CUSTOMER" && (
                  <p>Čaká sa na vyjadrenie poskytovateľa.</p>
                )}
                {proposalLoad.proposals.length === 0 ? (
                  <p>Zatiaľ bez návrhu od zákazníka.</p>
                ) : (
                  <ol>
                    {proposalLoad.proposals.map((proposal) => (
                      <li key={proposal.id}>
                        <p>
                          Návrh {proposal.proposalNumber} ·{" "}
                          {proposal.outcome === "PENDING"
                            ? "Čaká na poskytovateľa"
                            : proposal.outcome === "AGREE"
                              ? "Poskytovateľ súhlasil"
                              : "Poskytovateľ nesúhlasil"}
                        </p>
                        <time dateTime={proposal.proposedAt}>
                          {dateTime(proposal.proposedAt)}
                        </time>
                        {proposal.note && <p>Poznámka: {proposal.note}</p>}
                        {proposal.disagreementReason && (
                          <p>Dôvod nesúhlasu: {proposal.disagreementReason}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </section>
          {jobState === "IN_PROGRESS" && role === "PRIMARY_PROVIDER" && (
            <div>
              <h3>Požiadať o potvrdenie dokončenia</h3>
              <p>
                Pred odoslaním skontrolujte aktuálnu obchodnú dohodu, schválené
                zmeny, dokumentáciu a účastníkov vyššie na stránke.
              </p>
              {milestoneWarning && <p role="alert">{milestoneWarning}</p>}
              {rosterWarning && <p role="alert">{rosterWarning}</p>}
              {proposalPending && (
                <p role="alert">
                  Najprv výslovne odpovedzte na návrh zákazníka.
                </p>
              )}
              <label htmlFor="completion-note">
                Poznámka k odovzdaniu (nepovinná)
              </label>
              <textarea
                id="completion-note"
                maxLength={1000}
                disabled={pending}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <label htmlFor="completion-finished-on">
                Deň fyzického ukončenia prác (nepovinný)
              </label>
              <input
                id="completion-finished-on"
                type="date"
                disabled={pending}
                value={finishedOn}
                onChange={(event) => setFinishedOn(event.target.value)}
              />
              <MediaChoices
                media={media.filter(
                  (item) => item.authorRole === "PRIMARY_PROVIDER",
                )}
                selected={selectedMedia}
                onToggle={toggleMedia}
                disabled={pending}
                title="Záverečné fotografie a dokumenty"
              />
              <button
                type="button"
                disabled={
                  pending ||
                  note.length > 1000 ||
                  proposalLoad?.status !== "OK" ||
                  proposalPending
                }
                onClick={() =>
                  void submit("REQUEST", {
                    kind: "REQUEST",
                    ...(note.trim() ? { note: note.trim() } : {}),
                    ...(finishedOn
                      ? { physicalWorkFinishedOn: finishedOn }
                      : {}),
                    finalMediaAssetIds: selectedMedia,
                  })
                }
              >
                Požiadať o potvrdenie dokončenia
              </button>
            </div>
          )}
          {jobState === "COMPLETION_REQUESTED" &&
            latest?.outcome === "PENDING" &&
            role === "CUSTOMER" && (
              <div>
                <h3>Rozhodnúť o dokončení</h3>
                <p>
                  Pred rozhodnutím si prezrite aktuálnu dohodu a priložené
                  záverečné podklady. Potvrdenie nemení platobný stav.
                </p>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void submit(`ACCEPT:${latest.id}`, {
                      kind: "ACCEPT",
                      attemptId: latest.id,
                    })
                  }
                >
                  Potvrdiť dokončenie
                </button>
                <label htmlFor="completion-category">
                  Ak máte výhrady, vyberte dôvod
                </label>
                <select
                  id="completion-category"
                  disabled={pending}
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as CompletionCategory)
                  }
                >
                  {Object.entries(categoryName).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <label htmlFor="completion-reason">Konkrétna výhrada</label>
                <textarea
                  id="completion-reason"
                  minLength={8}
                  maxLength={1000}
                  disabled={pending}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <MediaChoices
                  media={media.filter((item) => item.authorRole === "CUSTOMER")}
                  selected={selectedMedia}
                  onToggle={toggleMedia}
                  disabled={pending}
                  title="Podklady k výhrade"
                />
                <button
                  type="button"
                  disabled={
                    pending || reason.trim().length < 8 || reason.length > 1000
                  }
                  onClick={() =>
                    void submit(`REJECT:${latest.id}`, {
                      kind: "REJECT",
                      attemptId: latest.id,
                      category,
                      reason: reason.trim(),
                      evidenceMediaAssetIds: selectedMedia,
                    })
                  }
                >
                  Nie je hotovo / mám výhrady
                </button>
              </div>
            )}
          {jobState === "COMPLETION_REQUESTED" &&
            latest?.outcome === "PENDING" &&
            role === "PRIMARY_PROVIDER" && (
              <div>
                <p>
                  Čaká sa na rozhodnutie zákazníka. Ak treba najprv schváliť
                  materiálnu zmenu, stiahnite žiadosť a pokračujte v práci.
                </p>
                <label htmlFor="completion-withdraw-reason">
                  Dôvod stiahnutia žiadosti
                </label>
                <textarea
                  id="completion-withdraw-reason"
                  minLength={8}
                  maxLength={1000}
                  disabled={pending}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <button
                  type="button"
                  disabled={
                    pending || reason.trim().length < 8 || reason.length > 1000
                  }
                  onClick={() =>
                    void submit(`WITHDRAW:${latest.id}`, {
                      kind: "WITHDRAW",
                      attemptId: latest.id,
                      reason: reason.trim(),
                    })
                  }
                >
                  Stiahnuť žiadosť o dokončenie
                </button>
              </div>
            )}
          {page.attempts.length === 0 ? (
            <p>Zatiaľ bez pokusu o dokončenie.</p>
          ) : (
            <ol>
              {page.attempts.map((attempt) => (
                <li key={attempt.id}>
                  <h3>
                    Pokus {attempt.attemptNumber} ·{" "}
                    {outcomeName[attempt.outcome]}
                  </h3>
                  <p>
                    Žiadosť:{" "}
                    <time dateTime={attempt.requestedAt}>
                      {dateTime(attempt.requestedAt)}
                    </time>
                  </p>
                  {attempt.physicalWorkFinishedOn && (
                    <p>
                      Uvedený deň dokončenia prác:{" "}
                      {attempt.physicalWorkFinishedOn}
                    </p>
                  )}
                  {attempt.note && (
                    <p>Poznámka poskytovateľa: {attempt.note}</p>
                  )}
                  <MediaLinks
                    paths={attempt.finalMediaDownloadPaths}
                    title="Záverečné podklady"
                  />
                  {attempt.decidedAt && (
                    <p>
                      Rozhodnutie:{" "}
                      <time dateTime={attempt.decidedAt}>
                        {dateTime(attempt.decidedAt)}
                      </time>
                    </p>
                  )}
                  {attempt.rejectionCategory && (
                    <p>Výhrada: {categoryName[attempt.rejectionCategory]}</p>
                  )}
                  {attempt.rejectionReason && (
                    <p>Dôvod: {attempt.rejectionReason}</p>
                  )}
                  <MediaLinks
                    paths={attempt.objectionMediaDownloadPaths}
                    title="Podklady k výhrade"
                  />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}

function MediaChoices({
  media,
  selected,
  onToggle,
  disabled,
  title,
}: {
  media: readonly JobDocumentItem[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  disabled: boolean;
  title: string;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>{title} (nepovinné)</legend>
      <p>
        Vyberte najviac 10 už overených súkromných súborov z dokumentácie
        zákazky.
      </p>
      {media.length === 0 && <p>Zatiaľ bez vhodných súborov.</p>}
      {media.map((item) => (
        <label key={item.mediaAssetId}>
          <input
            type="checkbox"
            checked={selected.includes(item.mediaAssetId)}
            disabled={
              !selected.includes(item.mediaAssetId) && selected.length >= 10
            }
            onChange={() => onToggle(item.mediaAssetId)}
          />
          {item.displayFilename ??
            (item.kind === "PHOTO" ? "Fotografia" : "Dokument PDF")}
        </label>
      ))}
    </fieldset>
  );
}
function MediaLinks({
  paths,
  title,
}: {
  paths: readonly string[];
  title: string;
}) {
  if (paths.length === 0) return null;
  return (
    <div>
      <h4>{title}</h4>
      <ul>
        {paths.map((path, index) => (
          <li key={path}>
            <a href={path}>
              {title} {index + 1}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
