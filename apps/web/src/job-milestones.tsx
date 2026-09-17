"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  JobMilestoneComments,
  JobMilestoneMedia,
  JobMilestoneProposals,
} from "./job-milestone-context";
import {
  loadMilestone,
  loadMilestoneHistory,
  loadMilestonePage,
  sendMilestoneCommand,
  type MilestoneCommand,
  type MilestoneHistoryItem,
  type MilestoneHistoryPage,
  type MilestoneItem,
  type MilestonePage,
  type MilestoneResponsibility,
  type MilestoneState,
} from "./job-milestone-data";
import {
  loadJobRosterPage,
  loadJobWorkGroupListPage,
  type JobRosterPage,
  type JobWorkGroupListPage,
} from "./job-roster";

const stateLabel: Record<MilestoneState, string> = {
  PLANNED: "Plánovaný",
  IN_PROGRESS: "Prebieha",
  DONE: "Hotový",
  SKIPPED: "Vynechaný",
};
const historyKindLabel: Record<MilestoneHistoryItem["kind"], string> = {
  CREATE: "Míľnik vytvorený",
  EDIT: "Upravený prevádzkový plán",
  STATE: "Zmenený stav",
  REORDER: "Zmenené poradie",
  ASSIGN: "Zmenená zodpovednosť",
};
const dateLabel = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("sk-SK", {
    timeZone: "UTC",
  });
const datetimeLabel = (value: string) =>
  new Date(value).toLocaleString("sk-SK");
const planLabel = (start: string | null, end: string | null) => {
  if (start && end) return `${dateLabel(start)} – ${dateLabel(end)}`;
  if (start) return `od ${dateLabel(start)}`;
  if (end) return `do ${dateLabel(end)}`;
  return "Bez určeného dátumu";
};

export function MilestoneSummary({
  item,
  responsibilityName,
  headingLevel = "h3",
}: {
  item: MilestoneItem;
  responsibilityName?: string | undefined;
  headingLevel?: "h1" | "h3";
}) {
  const Heading = headingLevel;
  const planMoved =
    item.originalPlannedStartOn !== item.currentPlannedStartOn ||
    item.originalPlannedEndOn !== item.currentPlannedEndOn;
  return (
    <div className="job-milestone-summary">
      <Heading>{item.title}</Heading>
      <p>Stav: {stateLabel[item.state]}</p>
      {item.description && <p>{item.description}</p>}
      <p>
        Aktuálny prevádzkový plán:{" "}
        {planLabel(item.currentPlannedStartOn, item.currentPlannedEndOn)}
      </p>
      {planMoved && (
        <p>
          Pôvodný prevádzkový plán:{" "}
          {planLabel(item.originalPlannedStartOn, item.originalPlannedEndOn)}.
          Zmena dátumu sama nemení prijatý zmluvný harmonogram.
        </p>
      )}
      {item.acceptedStageLabel && (
        <div>
          <p>
            Etapa podľa prijatej ponuky: {item.acceptedStageLabel} (revízia{" "}
            {item.sourceQuoteRevision}). Toto priradenie opísal poskytovateľ;
            nemení prijatú cenu ani podmienky.
          </p>
          {item.sourcePdfDownloadPath && (
            <p>
              <a href={item.sourcePdfDownloadPath}>Otvoriť prijaté PDF</a>
            </p>
          )}
        </div>
      )}
      {item.sourceChangeOrderRevisionId && (
        <p>
          Väzba na schválenú revíziu zmeny: {item.sourceChangeOrderRevisionId}.
          Míľnik sám nemení cenu ani zmluvné podmienky.
        </p>
      )}
      {item.responsibility && (
        <p>
          Zodpovednosť:{" "}
          {responsibilityName ??
            (item.responsibility.kind === "PARTICIPANT"
              ? "účastník zákazky"
              : "pracovná skupina")}
        </p>
      )}
      {item.acknowledgedAt && (
        <p>
          Prečítané zákazníkom:{" "}
          <time dateTime={item.acknowledgedAt}>
            {datetimeLabel(item.acknowledgedAt)}
          </time>
          . Nie je to odovzdanie ani prijatie diela.
        </p>
      )}
      <p>
        Vytvorené{" "}
        <time dateTime={item.createdAt}>{datetimeLabel(item.createdAt)}</time>
        {item.updatedAt !== item.createdAt && (
          <>
            {" "}
            · posledná zmena{" "}
            <time dateTime={item.updatedAt}>
              {datetimeLabel(item.updatedAt)}
            </time>
          </>
        )}
      </p>
    </div>
  );
}

type Draft = {
  title: string;
  description: string;
  plannedStartOn: string;
  plannedEndOn: string;
  acceptedStageLabel: string;
  sourceChangeOrderRevisionId: string;
};
const emptyDraft: Draft = {
  title: "",
  description: "",
  plannedStartOn: "",
  plannedEndOn: "",
  acceptedStageLabel: "",
  sourceChangeOrderRevisionId: "",
};
const fromItem = (item: MilestoneItem): Draft => ({
  title: item.title,
  description: item.description ?? "",
  plannedStartOn: item.currentPlannedStartOn ?? "",
  plannedEndOn: item.currentPlannedEndOn ?? "",
  acceptedStageLabel: item.acceptedStageLabel ?? "",
  sourceChangeOrderRevisionId: item.sourceChangeOrderRevisionId ?? "",
});
const draftDatesValid = (draft: Draft) =>
  !draft.plannedStartOn ||
  !draft.plannedEndOn ||
  draft.plannedStartOn <= draft.plannedEndOn;
const draftValid = (draft: Draft, mode: "CREATE" | "EDIT") =>
  draft.title.trim().length > 0 &&
  draft.title.length <= 160 &&
  draft.description.length <= 2_000 &&
  draft.acceptedStageLabel.length <= 160 &&
  (mode !== "CREATE" ||
    !draft.acceptedStageLabel.trim() ||
    !draft.sourceChangeOrderRevisionId) &&
  draftDatesValid(draft);

export function MilestoneEditor({
  draft,
  onChange,
  onSubmit,
  pending,
  mode,
  acceptedQuoteAvailable,
  approvedChanges = [],
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  onSubmit: () => void;
  pending: boolean;
  mode: "CREATE" | "EDIT";
  acceptedQuoteAvailable: boolean;
  approvedChanges?: readonly { revisionId: string; revisionNumber: number }[];
}) {
  const prefix =
    mode === "CREATE" ? "job-milestone-create" : "job-milestone-edit";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (draftValid(draft, mode)) onSubmit();
      }}
    >
      <label htmlFor={`${prefix}-title`}>Názov míľnika</label>
      <input
        id={`${prefix}-title`}
        maxLength={160}
        required
        disabled={pending}
        value={draft.title}
        onChange={(event) => onChange({ ...draft, title: event.target.value })}
      />
      <label htmlFor={`${prefix}-description`}>Opis (nepovinný)</label>
      <textarea
        id={`${prefix}-description`}
        maxLength={2000}
        disabled={pending}
        value={draft.description}
        onChange={(event) =>
          onChange({ ...draft, description: event.target.value })
        }
      />
      <label htmlFor={`${prefix}-start`}>
        Začiatok prevádzkového plánu (nepovinný)
      </label>
      <input
        id={`${prefix}-start`}
        type="date"
        disabled={pending}
        value={draft.plannedStartOn}
        onChange={(event) =>
          onChange({ ...draft, plannedStartOn: event.target.value })
        }
      />
      <label htmlFor={`${prefix}-end`}>
        Koniec prevádzkového plánu (nepovinný)
      </label>
      <input
        id={`${prefix}-end`}
        type="date"
        disabled={pending}
        value={draft.plannedEndOn}
        onChange={(event) =>
          onChange({ ...draft, plannedEndOn: event.target.value })
        }
      />
      {!draftDatesValid(draft) && (
        <p role="alert">Koniec musí byť v deň začiatku alebo neskôr.</p>
      )}
      {mode === "CREATE" && acceptedQuoteAvailable && (
        <>
          <label htmlFor={`${prefix}-stage`}>
            Etapa uvedená v prijatej ponuke (nepovinná)
          </label>
          <input
            id={`${prefix}-stage`}
            maxLength={160}
            disabled={pending}
            value={draft.acceptedStageLabel}
            onChange={(event) =>
              onChange({ ...draft, acceptedStageLabel: event.target.value })
            }
          />
          <p>
            Uveďte len etapu, ktorá už je v prijatej ponuke. Novú cenu ani
            platbu tu neurčujete.
          </p>
        </>
      )}
      {approvedChanges.length > 0 && (
        <>
          <label htmlFor={`${prefix}-change-revision`}>
            Schválená revízia zmeny (nepovinná)
          </label>
          <select
            id={`${prefix}-change-revision`}
            disabled={pending}
            value={draft.sourceChangeOrderRevisionId}
            onChange={(event) =>
              onChange({
                ...draft,
                sourceChangeOrderRevisionId: event.target.value,
              })
            }
          >
            <option value="">Bez novej väzby</option>
            {approvedChanges.map((change) => (
              <option key={change.revisionId} value={change.revisionId}>
                Schválená revízia {change.revisionNumber} · {change.revisionId}
              </option>
            ))}
          </select>
          <p>
            Väzba len zaznamenáva pôvod plánu; nezakladá cenu ani schválenie.
          </p>
        </>
      )}
      {mode === "CREATE" &&
        draft.acceptedStageLabel.trim() &&
        draft.sourceChangeOrderRevisionId && (
          <p role="alert">
            Pri vytvorení zvoľte buď etapu prijatej ponuky, alebo schválenú
            revíziu zmeny.
          </p>
        )}
      <button type="submit" disabled={pending || !draftValid(draft, mode)}>
        {mode === "CREATE" ? "Pridať míľnik" : "Uložiť prevádzkový plán"}
      </button>
    </form>
  );
}

function responsibilityOptions(
  roster: JobRosterPage | null,
  groups: JobWorkGroupListPage | null,
) {
  return [
    ...(roster?.participants
      .filter((person) => person.state === "ACCEPTED")
      .map((person) => ({
        value: `PARTICIPANT:${person.id}`,
        label: `Účastník: ${person.displayName}`,
      })) ?? []),
    ...(groups?.groups.map((group) => ({
      value: `WORK_GROUP:${group.id}`,
      label: `Skupina: ${group.name}`,
    })) ?? []),
  ];
}
function parseResponsibilityOption(
  value: string,
): MilestoneResponsibility | null {
  if (!value) return null;
  const [kind, id] = value.split(":");
  return (kind === "PARTICIPANT" || kind === "WORK_GROUP") && id
    ? { kind, id }
    : null;
}

export function JobMilestones({
  jobId,
  role,
  jobState,
  acceptedQuoteAvailable,
  approvedChanges = [],
}: {
  jobId: string;
  role: "CUSTOMER" | "PRIMARY_PROVIDER";
  jobState:
    | "CONFIRMED"
    | "IN_PROGRESS"
    | "COMPLETION_REQUESTED"
    | "COMPLETED"
    | "CANCELLED";
  acceptedQuoteAvailable: boolean;
  approvedChanges?: readonly {
    revisionId: string;
    revisionNumber: number;
    terms?: Record<string, unknown>;
  }[];
}) {
  const writable = jobState === "CONFIRMED" || jobState === "IN_PROGRESS";
  const [page, setPage] = useState<MilestonePage | null>(null);
  const [loadStatus, setLoadStatus] = useState<"LOADING" | "OK" | "ERROR">(
    "LOADING",
  );
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [roster, setRoster] = useState<JobRosterPage | null>(null);
  const [groups, setGroups] = useState<JobWorkGroupListPage | null>(null);
  const [optionsPending, setOptionsPending] = useState(false);
  const [optionsReady, setOptionsReady] = useState(false);
  const attempts = useRef(
    new Map<string, { intent: string; commandId: string }>(),
  );
  const refresh = useCallback(async () => {
    const result = await loadMilestonePage({ fetch: globalThis.fetch, jobId });
    if (result.status === "OK") {
      setPage(result.value);
      setLoadStatus("OK");
    } else {
      setPage(null);
      setLoadStatus("ERROR");
    }
  }, [jobId]);
  useEffect(() => {
    let active = true;
    setPage(null);
    setLoadStatus("LOADING");
    setRoster(null);
    setGroups(null);
    setOptionsReady(false);
    setDraft(emptyDraft);
    setEditId(null);
    setNotice("");
    attempts.current.clear();
    void loadMilestonePage({ fetch: globalThis.fetch, jobId }).then(
      (result) => {
        if (!active) return;
        if (result.status === "OK") {
          setPage(result.value);
          setLoadStatus("OK");
        } else setLoadStatus("ERROR");
      },
    );
    return () => {
      active = false;
    };
  }, [jobId]);
  const command = async (key: string, action: MilestoneCommand) => {
    if (pending || !writable) return false;
    const intent = JSON.stringify(action);
    const previous = attempts.current.get(key);
    const commandId =
      previous?.intent === intent ? previous.commandId : crypto.randomUUID();
    attempts.current.set(key, { intent, commandId });
    setPending(true);
    setNotice("");
    const result = await sendMilestoneCommand({
      fetch: globalThis.fetch,
      jobId,
      commandId,
      command: action,
    });
    if (result.status === "OK") {
      attempts.current.delete(key);
      await refresh();
      setNotice(
        "Zmena míľnika bola potvrdená. História predchádzajúcich hodnôt zostáva zachovaná.",
      );
    } else {
      setNotice(
        result.status === "AUTH_REQUIRED"
          ? "Relácia sa skončila. Prihláste sa znova."
          : result.status === "CONFLICT"
            ? "Medzitým sa plán zmenil. Obnovte stránku a skontrolujte aktuálne údaje."
            : "Výsledok akcie sa nepodarilo potvrdiť. Zopakujte nezmenenú akciu alebo obnovte prehľad.",
      );
    }
    setPending(false);
    return result.status === "OK";
  };
  const create = async () => {
    if (
      !page?.canCreate ||
      role !== "PRIMARY_PROVIDER" ||
      !draftValid(draft, "CREATE")
    )
      return;
    const action: MilestoneCommand = {
      kind: "CREATE",
      title: draft.title.trim(),
      ...(draft.description.trim()
        ? { description: draft.description.trim() }
        : {}),
      plannedStartOn: draft.plannedStartOn || null,
      plannedEndOn: draft.plannedEndOn || null,
      ...(draft.acceptedStageLabel.trim() && acceptedQuoteAvailable
        ? { acceptedStageLabel: draft.acceptedStageLabel.trim() }
        : {}),
      ...(draft.sourceChangeOrderRevisionId
        ? { sourceChangeOrderRevisionId: draft.sourceChangeOrderRevisionId }
        : {}),
    };
    if (await command("CREATE", action)) setDraft(emptyDraft);
  };
  const edit = async (item: MilestoneItem) => {
    if (
      !item.capabilities.canEdit ||
      editId !== item.id ||
      !draftValid(editDraft, "EDIT")
    )
      return;
    const action: MilestoneCommand = {
      kind: "EDIT",
      milestoneId: item.id,
      title: editDraft.title.trim(),
      description: editDraft.description.trim() || null,
      plannedStartOn: editDraft.plannedStartOn || null,
      plannedEndOn: editDraft.plannedEndOn || null,
      ...(editDraft.sourceChangeOrderRevisionId &&
      editDraft.sourceChangeOrderRevisionId !== item.sourceChangeOrderRevisionId
        ? { sourceChangeOrderRevisionId: editDraft.sourceChangeOrderRevisionId }
        : {}),
    };
    if (await command(`EDIT:${item.id}`, action)) setEditId(null);
  };
  const more = async () => {
    if (!page?.nextCursor || pending) return;
    setPending(true);
    const result = await loadMilestonePage({
      fetch: globalThis.fetch,
      jobId,
      cursor: page.nextCursor,
    });
    if (
      result.status === "OK" &&
      !result.value.items.some((item) =>
        page.items.some((old) => old.id === item.id),
      )
    ) {
      setPage({
        ...result.value,
        items: [...page.items, ...result.value.items],
      });
    } else setNotice("Ďalšie míľniky sa nepodarilo bezpečne načítať.");
    setPending(false);
  };
  const moreRoster = async () => {
    if (!roster?.nextCursor || optionsPending) return;
    setOptionsPending(true);
    const next = await loadJobRosterPage({
      fetch: globalThis.fetch,
      jobId,
      cursor: roster.nextCursor,
    });
    if (
      next &&
      next.role === roster.role &&
      !next.participants.some((item) =>
        roster.participants.some((old) => old.id === item.id),
      )
    ) {
      setRoster({
        ...next,
        participants: [...roster.participants, ...next.participants],
      });
    } else setNotice("Ďalších účastníkov sa nepodarilo bezpečne načítať.");
    setOptionsPending(false);
  };
  const loadOptions = async () => {
    if (optionsPending || role !== "PRIMARY_PROVIDER" || !writable) return;
    setOptionsPending(true);
    const [nextRoster, nextGroups] = await Promise.all([
      loadJobRosterPage({ fetch: globalThis.fetch, jobId }),
      loadJobWorkGroupListPage({ fetch: globalThis.fetch, jobId }),
    ]);
    if (nextRoster?.role === "PRIMARY_PROVIDER" && nextGroups) {
      setRoster(nextRoster);
      setGroups(nextGroups);
      setOptionsReady(true);
    } else setNotice("Možnosti priradenia sa nepodarilo bezpečne načítať.");
    setOptionsPending(false);
  };
  const moreGroups = async () => {
    if (!groups?.nextCursor || optionsPending) return;
    setOptionsPending(true);
    const next = await loadJobWorkGroupListPage({
      fetch: globalThis.fetch,
      jobId,
      cursor: groups.nextCursor,
    });
    if (
      next &&
      !next.groups.some((item) =>
        groups.groups.some((old) => old.id === item.id),
      )
    ) {
      setGroups({ ...next, groups: [...groups.groups, ...next.groups] });
    } else setNotice("Ďalšie pracovné skupiny sa nepodarilo bezpečne načítať.");
    setOptionsPending(false);
  };
  const options = responsibilityOptions(roster, groups);
  const nameFor = (item: MilestoneItem) =>
    options.find(
      (option) =>
        option.value ===
        `${item.responsibility?.kind}:${item.responsibility?.id}`,
    )?.label;
  return (
    <section aria-labelledby="job-milestones">
      <h2 id="job-milestones">Míľniky zákazky</h2>
      <p>
        Nepovinné body priebehu prác. Nemenia dohodnutú cenu, rozsah ani hlavný
        stav zákazky. Vecné zmeny dohody vyžadujú samostatný schválený postup
        zmeny objednávky.
      </p>
      {loadStatus === "LOADING" && <p role="status">Načítavajú sa míľniky…</p>}
      {loadStatus === "ERROR" && (
        <p role="alert">Míľniky sa nepodarilo bezpečne načítať.</p>
      )}
      {notice && <p role="alert">{notice}</p>}
      {page && (
        <>
          <JobMilestoneProposals
            jobId={jobId}
            role={role}
            jobState={jobState}
            milestones={page.items}
          />
          {page.items.length === 0 ? (
            <p>Zatiaľ nie sú vytvorené míľniky.</p>
          ) : (
            <ol className="job-milestone-list">
              {page.items.map((item, index) => (
                <li key={item.id}>
                  <MilestoneSummary
                    item={item}
                    {...(nameFor(item)
                      ? { responsibilityName: nameFor(item) }
                      : {})}
                  />
                  <p>
                    <Link href={`/zakazky/${jobId}/milniky/${item.id}`}>
                      Otvoriť míľnik
                    </Link>
                  </p>
                  {role === "CUSTOMER" &&
                    writable &&
                    item.capabilities.canAcknowledge &&
                    !item.acknowledgedAt && (
                      <button
                        disabled={pending}
                        type="button"
                        onClick={() =>
                          void command(`ACK:${item.id}`, {
                            kind: "ACKNOWLEDGE",
                            milestoneId: item.id,
                          })
                        }
                      >
                        Potvrdiť prečítanie (nie odovzdanie diela)
                      </button>
                    )}
                  {role === "PRIMARY_PROVIDER" &&
                    writable &&
                    item.capabilities.canEdit && (
                      <div>
                        {editId === item.id ? (
                          <>
                            <MilestoneEditor
                              draft={editDraft}
                              onChange={setEditDraft}
                              onSubmit={() => void edit(item)}
                              pending={pending}
                              mode="EDIT"
                              acceptedQuoteAvailable={acceptedQuoteAvailable}
                              approvedChanges={approvedChanges.filter(
                                (change) =>
                                  Array.isArray(
                                    change.terms?.affectedMilestoneIds,
                                  ) &&
                                  change.terms.affectedMilestoneIds.includes(
                                    item.id,
                                  ),
                              )}
                            />
                            <button
                              disabled={pending}
                              type="button"
                              onClick={() => setEditId(null)}
                            >
                              Zrušiť úpravu
                            </button>
                          </>
                        ) : (
                          <button
                            disabled={pending}
                            type="button"
                            onClick={() => {
                              setEditId(item.id);
                              setEditDraft(fromItem(item));
                            }}
                          >
                            Upraviť plán
                          </button>
                        )}
                      </div>
                    )}
                  {role === "PRIMARY_PROVIDER" &&
                    writable &&
                    item.capabilities.canSetState && (
                      <fieldset disabled={pending}>
                        <legend>Zmeniť stav míľnika</legend>
                        {(
                          ["PLANNED", "IN_PROGRESS", "DONE", "SKIPPED"] as const
                        )
                          .filter(
                            (state) =>
                              state !== item.state &&
                              ((state !== "DONE" && state !== "SKIPPED") ||
                                item.capabilities.canMarkDone),
                          )
                          .map((state) => (
                            <button
                              key={state}
                              type="button"
                              onClick={() =>
                                void command(`STATE:${item.id}:${state}`, {
                                  kind: "STATE",
                                  milestoneId: item.id,
                                  state,
                                })
                              }
                            >
                              {stateLabel[state]}
                            </button>
                          ))}
                      </fieldset>
                    )}
                  {role === "PRIMARY_PROVIDER" &&
                    writable &&
                    item.capabilities.canReorder &&
                    index > 0 && (
                      <button
                        disabled={pending}
                        type="button"
                        onClick={() =>
                          void command(`REORDER:${item.id}`, {
                            kind: "REORDER",
                            milestoneId: item.id,
                            afterMilestoneId:
                              index > 1 ? page.items[index - 2]!.id : null,
                          })
                        }
                      >
                        Posunúť vyššie
                      </button>
                    )}
                  {role === "PRIMARY_PROVIDER" &&
                    writable &&
                    item.capabilities.canAssign && (
                      <div>
                        <label htmlFor={`job-milestone-assign-${item.id}`}>
                          Priradiť zodpovednosť
                        </label>
                        <select
                          id={`job-milestone-assign-${item.id}`}
                          disabled={pending || !optionsReady}
                          value={
                            item.responsibility
                              ? `${item.responsibility.kind}:${item.responsibility.id}`
                              : ""
                          }
                          onChange={(event) =>
                            void command(`ASSIGN:${item.id}`, {
                              kind: "ASSIGN",
                              milestoneId: item.id,
                              responsibility: parseResponsibilityOption(
                                event.target.value,
                              ),
                            })
                          }
                        >
                          <option value="">Bez priradenia</option>
                          {item.responsibility &&
                            !options.some(
                              (option) =>
                                option.value ===
                                `${item.responsibility!.kind}:${item.responsibility!.id}`,
                            ) && (
                              <option
                                value={`${item.responsibility.kind}:${item.responsibility.id}`}
                              >
                                Doterajšie priradenie
                              </option>
                            )}
                          {options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                </li>
              ))}
            </ol>
          )}
          {page.nextCursor && (
            <button
              disabled={pending}
              type="button"
              onClick={() => void more()}
            >
              Načítať ďalšie míľniky
            </button>
          )}
          {role === "PRIMARY_PROVIDER" &&
            writable &&
            page.items.some((item) => item.capabilities.canAssign) &&
            !optionsReady && (
              <button
                disabled={pending || optionsPending}
                type="button"
                onClick={() => void loadOptions()}
              >
                Načítať možnosti priradenia z tejto zákazky
              </button>
            )}
          {role === "PRIMARY_PROVIDER" && writable && roster?.nextCursor && (
            <button
              disabled={pending || optionsPending}
              type="button"
              onClick={() => void moreRoster()}
            >
              Načítať ďalších zodpovedných účastníkov
            </button>
          )}
          {role === "PRIMARY_PROVIDER" && writable && groups?.nextCursor && (
            <button
              disabled={pending || optionsPending}
              type="button"
              onClick={() => void moreGroups()}
            >
              Načítať ďalšie pracovné skupiny
            </button>
          )}
          {role === "PRIMARY_PROVIDER" && writable && page.canCreate && (
            <div>
              <h3>Pridať prevádzkový míľnik</h3>
              <MilestoneEditor
                draft={draft}
                onChange={setDraft}
                onSubmit={() => void create()}
                pending={pending}
                mode="CREATE"
                approvedChanges={approvedChanges}
                acceptedQuoteAvailable={acceptedQuoteAvailable}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function JobMilestoneDetail({
  jobId,
  milestoneId,
}: {
  jobId: string;
  milestoneId: string;
}) {
  const [item, setItem] = useState<MilestoneItem | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "AUTH_REQUIRED" | "UNAVAILABLE"
  >("LOADING");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const retry = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    setItem(null);
    setStatus("LOADING");
    retry.current = null;
    void loadMilestone({ fetch: globalThis.fetch, jobId, milestoneId }).then(
      (result) => {
        if (!active) return;
        if (result.status === "OK") {
          setItem(result.value);
          setStatus("OK");
        } else
          setStatus(
            result.status === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "UNAVAILABLE",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [jobId, milestoneId]);
  const acknowledge = async () => {
    if (!item?.capabilities.canAcknowledge || pending || item.acknowledgedAt)
      return;
    retry.current ??= crypto.randomUUID();
    setPending(true);
    setNotice("");
    const result = await sendMilestoneCommand({
      fetch: globalThis.fetch,
      jobId,
      commandId: retry.current,
      command: { kind: "ACKNOWLEDGE", milestoneId },
    });
    if (result.status === "OK") {
      retry.current = null;
      const refreshed = await loadMilestone({
        fetch: globalThis.fetch,
        jobId,
        milestoneId,
      });
      if (refreshed.status === "OK") setItem(refreshed.value);
      else
        setNotice("Potvrdenie sa uložilo, ale míľnik sa nepodarilo obnoviť.");
    } else
      setNotice(
        result.status === "AUTH_REQUIRED"
          ? "Relácia sa skončila. Prihláste sa znova."
          : "Výsledok potvrdenia sa nepodarilo overiť. Zopakujte rovnakú akciu.",
      );
    setPending(false);
  };
  if (status === "LOADING")
    return <p role="status">Načítava sa súkromný míľnik…</p>;
  if (status === "AUTH_REQUIRED")
    return <p role="alert">Najprv sa prihláste.</p>;
  if (status !== "OK" || !item)
    return <p role="alert">Míľnik nie je dostupný.</p>;
  return (
    <article className="job-milestone-detail">
      <p>
        <Link href={`/zakazky/${jobId}`}>Späť na zákazku</Link>
      </p>
      <MilestoneSummary item={item} headingLevel="h1" />
      <JobMilestoneHistory jobId={jobId} milestoneId={milestoneId} />
      <JobMilestoneComments jobId={jobId} milestoneId={milestoneId} />
      <JobMilestoneMedia jobId={jobId} milestoneId={milestoneId} />
      {item.capabilities.canAcknowledge && !item.acknowledgedAt && (
        <button
          disabled={pending}
          type="button"
          onClick={() => void acknowledge()}
        >
          Potvrdiť prečítanie (nie odovzdanie diela)
        </button>
      )}
      {notice && <p role="alert">{notice}</p>}
    </article>
  );
}

export function MilestoneHistoryItems({
  items,
}: {
  items: readonly MilestoneHistoryItem[];
}) {
  if (items.length === 0) return <p>Zatiaľ bez zaznamenanej histórie.</p>;
  return (
    <ol className="job-milestone-history-list">
      {items.map((entry) => (
        <li key={entry.eventId}>
          <h3>{historyKindLabel[entry.kind]}</h3>
          <p>
            <time dateTime={entry.recordedAt}>
              {datetimeLabel(entry.recordedAt)}
            </time>
          </p>
          <p>Vtedajší názov: {entry.title}</p>
          {entry.description && <p>Vtedajší opis: {entry.description}</p>}
          <p>
            {entry.kind === "CREATE" ? "Pôvodný" : "Vtedajší"} prevádzkový plán:{" "}
            {planLabel(entry.plannedStartOn, entry.plannedEndOn)}
          </p>
          <p>Vtedajší stav: {stateLabel[entry.state]}</p>
          {entry.responsibility && (
            <p>
              Vtedajšia zodpovednosť:{" "}
              {entry.responsibility.kind === "PARTICIPANT"
                ? "účastník zákazky"
                : "pracovná skupina"}
            </p>
          )}
          {entry.acceptedStageLabel && (
            <p>
              Odkaz na prijatú etapu: {entry.acceptedStageLabel} (revízia{" "}
              {entry.sourceQuoteRevision}).
              {entry.sourcePdfDownloadPath && (
                <>
                  {" "}
                  <a href={entry.sourcePdfDownloadPath}>Prijaté PDF</a>
                </>
              )}
            </p>
          )}
          {entry.sourceChangeOrderRevisionId && (
            <p>
              Vtedajšia schválená revízia zmeny:{" "}
              {entry.sourceChangeOrderRevisionId}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function JobMilestoneHistory({
  jobId,
  milestoneId,
}: {
  jobId: string;
  milestoneId: string;
}) {
  const [page, setPage] = useState<MilestoneHistoryPage | null>(null);
  const [status, setStatus] = useState<"LOADING" | "OK" | "ERROR">("LOADING");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setPage(null);
    setStatus("LOADING");
    setNotice("");
    void loadMilestoneHistory({
      fetch: globalThis.fetch,
      jobId,
      milestoneId,
    }).then((result) => {
      if (!active) return;
      if (result.status === "OK") {
        setPage(result.value);
        setStatus("OK");
      } else setStatus("ERROR");
    });
    return () => {
      active = false;
    };
  }, [jobId, milestoneId]);
  const more = async () => {
    if (!page?.nextCursor || pending) return;
    setPending(true);
    const result = await loadMilestoneHistory({
      fetch: globalThis.fetch,
      jobId,
      milestoneId,
      beforeSequence: page.nextCursor,
    });
    if (
      result.status === "OK" &&
      !result.value.items.some((item) =>
        page.items.some(
          (old) =>
            old.eventId === item.eventId || old.sequence === item.sequence,
        ),
      )
    ) {
      setPage({
        ...result.value,
        items: [...page.items, ...result.value.items],
      });
    } else setNotice("Staršiu históriu sa nepodarilo bezpečne načítať.");
    setPending(false);
  };
  return (
    <section aria-labelledby="job-milestone-history">
      <h2 id="job-milestone-history">História míľnika</h2>
      <p>
        Každý záznam zachytáva stav v čase zmeny. Aktuálny plán je uvedený
        vyššie; táto história nemení prijatú ponuku ani nepotvrdzuje platbu.
      </p>
      {status === "LOADING" && <p role="status">Načítava sa história…</p>}
      {status === "ERROR" && (
        <p role="alert">Históriu sa nepodarilo bezpečne načítať.</p>
      )}
      {page && <MilestoneHistoryItems items={page.items} />}
      {page?.nextCursor && (
        <button disabled={pending} type="button" onClick={() => void more()}>
          Načítať staršie zmeny
        </button>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
