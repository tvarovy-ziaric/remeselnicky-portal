"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import {
  loadChangeDetail,
  loadChangeOrders,
  loadExactRevision,
  resumeChangePdf,
  sendChangeCommand,
  startChangePdf,
  type ChangeCommand,
  type ChangeDetail,
  type ChangePage,
  type ChangeRevision,
  type ChangeTerms,
  type CommandResult,
  type PendingChangePdf,
  type PdfChangeCommand,
  type PdfWorkflowResult,
  type PriceImpact,
  type ScheduleImpact,
  type Side,
} from "./change-order-data";
import { parseJobDashboard } from "./job-dashboard";

const emptyTerms = (): ChangeTerms => ({
  title: "",
  reason: "",
  changeDescription: "",
  scopeAdded: [],
  scopeRemoved: [],
  scopeChanged: [],
  priceImpact: { mode: "NONE" },
  scheduleImpact: { mode: "NONE" },
  materialResponsibility: null,
  warrantyChange: null,
  otherConditionChange: null,
  affectedMilestoneIds: [],
  externalPdfDownloadPath: null,
});
const euro = (cents: number) =>
  new Intl.NumberFormat("sk-SK", { style: "currency", currency: "EUR" }).format(
    cents / 100,
  );
const sideName = (side: Side) =>
  side === "CUSTOMER" ? "zákazník" : "hlavný poskytovateľ";
const stateName: Record<ChangeRevision["state"], string> = {
  DRAFT: "Rozpracovaný návrh",
  PROPOSED: "Čaká na druhú stranu",
  APPROVED: "Schválená zmena",
  REJECTED: "Zamietnutá zmena",
  WITHDRAWN: "Stiahnutý návrh",
  SUPERSEDED: "Nahradená revízia",
};
const otherSide = (side: Side) =>
  side === "CUSTOMER" ? "PRIMARY_PROVIDER" : "CUSTOMER";
function Price({ value }: { value: PriceImpact }) {
  if (value.mode === "NONE") return <p>Cena sa nemení.</p>;
  const vat =
    value.vatStatus === "VAT_INCLUDED"
      ? "vrátane DPH"
      : value.vatStatus === "VAT_EXCLUDED"
        ? "bez DPH"
        : "neplatca DPH";
  if (value.mode === "RANGE_DELTA")
    return (
      <p>
        Rozsah zmeny ceny: {euro(value.minimumCents)} až{" "}
        {euro(value.maximumCents)} ({vat}); podklad: {value.basis}. Nie je to
        presná výsledná cena.
      </p>
    );
  if (value.mode === "ESTIMATE_DELTA")
    return (
      <p>
        Odhad zmeny ceny: {euro(value.amountCents)} ({vat}); podklad:{" "}
        {value.basis}. Nie je to presná výsledná cena.
      </p>
    );
  return (
    <p>
      Pevná zmena ceny: {euro(value.amountCents)} ({vat}).
    </p>
  );
}
function Schedule({ value }: { value: ScheduleImpact }) {
  if (value.mode === "NONE") return <p>Dohodnutý termín sa nemení.</p>;
  if (value.mode === "DAYS")
    return (
      <p>
        Zmena termínu: {value.deltaDays > 0 ? "+" : ""}
        {value.deltaDays} dní.
      </p>
    );
  if (value.mode === "DATE") return <p>Nový termín: {value.newDate}.</p>;
  return (
    <p>
      Nové obdobie: {value.startDate} až {value.endDate}.
    </p>
  );
}
export function ChangeTermsView({ terms }: { terms: ChangeTerms }) {
  return (
    <div>
      <h3>{terms.title}</h3>
      <p>Dôvod: {terms.reason}</p>
      <p>{terms.changeDescription}</p>
      {(
        [
          ["Pridaný rozsah", terms.scopeAdded],
          ["Odstránený rozsah", terms.scopeRemoved],
          ["Zmenený rozsah", terms.scopeChanged],
        ] as const
      ).map(([label, lines]) =>
        lines.length ? (
          <div key={label}>
            <h4>{label}</h4>
            <ul>
              {lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      <Price value={terms.priceImpact} />
      <Schedule value={terms.scheduleImpact} />
      {terms.materialResponsibility && (
        <p>
          Materiál zabezpečí:{" "}
          {terms.materialResponsibility === "PROVIDER"
            ? "poskytovateľ"
            : terms.materialResponsibility === "CUSTOMER"
              ? "zákazník"
              : "obe strany"}
          .
        </p>
      )}
      {terms.warrantyChange && <p>Zmena záruky: {terms.warrantyChange}</p>}
      {terms.otherConditionChange && (
        <p>Ďalšia podmienka: {terms.otherConditionChange}</p>
      )}
      {terms.affectedMilestoneIds.length > 0 && (
        <p>
          Dotknuté míľniky: {terms.affectedMilestoneIds.length}. Väzby sú
          uložené v revízii.
        </p>
      )}
      {terms.externalPdfDownloadPath ? (
        <a href={terms.externalPdfDownloadPath}>Otvoriť prílohu dodatku</a>
      ) : (
        <p>Externé PDF dodatku nie je k tejto revízii pripojené.</p>
      )}
    </div>
  );
}
function ScopeLines({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <label>
      {label}
      <textarea
        rows={3}
        value={value.join("\n")}
        onChange={(event) =>
          onChange(
            event.target.value
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          )
        }
        placeholder="Jedna položka na riadok"
      />
    </label>
  );
}
function ChangeTermsForm({
  initial,
  onSave,
  busy,
  submitLabel,
  allowPdf,
}: {
  initial?: ChangeTerms;
  onSave: (terms: ChangeTerms, file: File | null) => void;
  busy: boolean;
  submitLabel: string;
  allowPdf: boolean;
}) {
  const [terms, setTerms] = useState<ChangeTerms>(initial ?? emptyTerms());
  const [file, setFile] = useState<File | null>(null);
  const update = (patch: Partial<ChangeTerms>) =>
    setTerms((old) => ({ ...old, ...patch }));
  const priceMode = terms.priceImpact.mode;
  const scheduleMode = terms.scheduleImpact.mode;
  const priceAmount =
    priceMode === "FIXED_DELTA" || priceMode === "ESTIMATE_DELTA"
      ? terms.priceImpact.amountCents / 100
      : 0;
  const priceBasis =
    priceMode === "ESTIMATE_DELTA" || priceMode === "RANGE_DELTA"
      ? terms.priceImpact.basis
      : "";
  const vat =
    priceMode !== "NONE" ? terms.priceImpact.vatStatus : "VAT_INCLUDED";
  const number = (value: string) => Math.round(Number(value) * 100);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(terms, file);
      }}
    >
      <label>
        Názov zmeny
        <input
          required
          maxLength={160}
          value={terms.title}
          onChange={(e) => update({ title: e.target.value })}
        />
      </label>
      <label>
        Dôvod
        <input
          required
          maxLength={500}
          value={terms.reason}
          onChange={(e) => update({ reason: e.target.value })}
        />
      </label>
      <label>
        Čo sa mení
        <textarea
          required
          maxLength={4000}
          rows={4}
          value={terms.changeDescription}
          onChange={(e) => update({ changeDescription: e.target.value })}
        />
      </label>
      <ScopeLines
        label="Pridaný rozsah"
        value={terms.scopeAdded}
        onChange={(value) => update({ scopeAdded: value })}
      />
      <ScopeLines
        label="Odstránený rozsah"
        value={terms.scopeRemoved}
        onChange={(value) => update({ scopeRemoved: value })}
      />
      <ScopeLines
        label="Zmenený rozsah"
        value={terms.scopeChanged}
        onChange={(value) => update({ scopeChanged: value })}
      />
      <label>
        Zmena ceny
        <select
          value={priceMode}
          onChange={(e) => {
            const mode = e.target.value;
            update({
              priceImpact:
                mode === "NONE"
                  ? { mode: "NONE" }
                  : mode === "RANGE_DELTA"
                    ? {
                        mode: "RANGE_DELTA",
                        minimumCents: 0,
                        maximumCents: 0,
                        basis: "",
                        vatStatus: "VAT_INCLUDED",
                      }
                    : mode === "ESTIMATE_DELTA"
                      ? {
                          mode: "ESTIMATE_DELTA",
                          amountCents: 0,
                          basis: "",
                          vatStatus: "VAT_INCLUDED",
                        }
                      : {
                          mode: "FIXED_DELTA",
                          amountCents: 0,
                          vatStatus: "VAT_INCLUDED",
                        },
            });
          }}
        >
          <option value="NONE">Bez zmeny ceny</option>
          <option value="FIXED_DELTA">Pevná suma</option>
          <option value="ESTIMATE_DELTA">Odhad</option>
          <option value="RANGE_DELTA">Rozsah</option>
        </select>
      </label>
      {(priceMode === "FIXED_DELTA" || priceMode === "ESTIMATE_DELTA") && (
        <label>
          Zmena v EUR (kladná alebo záporná)
          <input
            type="number"
            step="0.01"
            required
            value={priceAmount}
            onChange={(e) =>
              update({
                priceImpact: {
                  ...terms.priceImpact,
                  amountCents: number(e.target.value),
                } as PriceImpact,
              })
            }
          />
        </label>
      )}
      {priceMode === "RANGE_DELTA" && (
        <>
          <label>
            Minimum zmeny v EUR
            <input
              type="number"
              step="0.01"
              required
              value={terms.priceImpact.minimumCents / 100}
              onChange={(e) =>
                update({
                  priceImpact: {
                    ...terms.priceImpact,
                    minimumCents: number(e.target.value),
                  } as PriceImpact,
                })
              }
            />
          </label>
          <label>
            Maximum zmeny v EUR
            <input
              type="number"
              step="0.01"
              required
              value={terms.priceImpact.maximumCents / 100}
              onChange={(e) =>
                update({
                  priceImpact: {
                    ...terms.priceImpact,
                    maximumCents: number(e.target.value),
                  } as PriceImpact,
                })
              }
            />
          </label>
        </>
      )}
      {(priceMode === "ESTIMATE_DELTA" || priceMode === "RANGE_DELTA") && (
        <label>
          Podklad odhadu
          <input
            required
            maxLength={500}
            value={priceBasis}
            onChange={(e) =>
              update({
                priceImpact: {
                  ...terms.priceImpact,
                  basis: e.target.value,
                } as PriceImpact,
              })
            }
          />
        </label>
      )}
      {priceMode !== "NONE" && (
        <label>
          DPH
          <select
            value={vat}
            onChange={(e) =>
              update({
                priceImpact: {
                  ...terms.priceImpact,
                  vatStatus: e.target.value,
                } as PriceImpact,
              })
            }
          >
            <option value="VAT_INCLUDED">Suma vrátane DPH</option>
            <option value="VAT_EXCLUDED">Suma bez DPH</option>
            <option value="NOT_VAT_REGISTERED">Neplatca DPH</option>
          </select>
        </label>
      )}
      <label>
        Zmena termínu
        <select
          value={scheduleMode}
          onChange={(e) => {
            const mode = e.target.value;
            update({
              scheduleImpact:
                mode === "NONE"
                  ? { mode: "NONE" }
                  : mode === "DAYS"
                    ? { mode: "DAYS", deltaDays: 1 }
                    : mode === "DATE"
                      ? { mode: "DATE", newDate: "" }
                      : { mode: "RANGE", startDate: "", endDate: "" },
            });
          }}
        >
          <option value="NONE">Bez zmeny termínu</option>
          <option value="DAYS">Posun v dňoch</option>
          <option value="DATE">Nový dátum</option>
          <option value="RANGE">Nové obdobie</option>
        </select>
      </label>
      {scheduleMode === "DAYS" && (
        <label>
          Počet dní
          <input
            type="number"
            required
            min={-3650}
            max={3650}
            value={terms.scheduleImpact.deltaDays}
            onChange={(e) =>
              update({
                scheduleImpact: {
                  mode: "DAYS",
                  deltaDays: Number(e.target.value),
                },
              })
            }
          />
        </label>
      )}
      {scheduleMode === "DATE" && (
        <label>
          Nový dátum
          <input
            type="date"
            required
            value={terms.scheduleImpact.newDate}
            onChange={(e) =>
              update({
                scheduleImpact: { mode: "DATE", newDate: e.target.value },
              })
            }
          />
        </label>
      )}
      {scheduleMode === "RANGE" && (
        <>
          <label>
            Začiatok
            <input
              type="date"
              required
              value={terms.scheduleImpact.startDate}
              onChange={(e) =>
                update({
                  scheduleImpact: {
                    ...terms.scheduleImpact,
                    startDate: e.target.value,
                  } as ScheduleImpact,
                })
              }
            />
          </label>
          <label>
            Koniec
            <input
              type="date"
              required
              value={terms.scheduleImpact.endDate}
              onChange={(e) =>
                update({
                  scheduleImpact: {
                    ...terms.scheduleImpact,
                    endDate: e.target.value,
                  } as ScheduleImpact,
                })
              }
            />
          </label>
        </>
      )}
      <label>
        Materiál
        <select
          value={terms.materialResponsibility ?? ""}
          onChange={(e) =>
            update({
              materialResponsibility:
                e.target.value === ""
                  ? null
                  : (e.target.value as ChangeTerms["materialResponsibility"]),
            })
          }
        >
          <option value="">Bez zmeny zodpovednosti</option>
          <option value="PROVIDER">Poskytovateľ</option>
          <option value="CUSTOMER">Zákazník</option>
          <option value="MIXED">Obe strany</option>
        </select>
      </label>
      <label>
        Zmena záruky
        <input
          maxLength={1000}
          value={terms.warrantyChange ?? ""}
          onChange={(e) => update({ warrantyChange: e.target.value || null })}
        />
      </label>
      <label>
        Ďalšia podmienka
        <input
          maxLength={1000}
          value={terms.otherConditionChange ?? ""}
          onChange={(e) =>
            update({ otherConditionChange: e.target.value || null })
          }
        />
      </label>
      {allowPdf ? (
        <>
          <label>
            Externý PDF dodatok (voliteľný, najviac 25 MB)
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <p>
            Pri PDF je záväzný obsah v súbore; tento vyplnený súhrn zostáva
            povinný. Každá nová revízia potrebuje vlastné PDF. Návrh sa uloží až
            po bezpečnostnej kontrole súboru.
          </p>
        </>
      ) : (
        <p>
          Externé PDF môže pridať iba hlavný poskytovateľ; záväzné podmienky
          musia byť zhrnuté aj tu.
        </p>
      )}
      <button type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}
function errorMessage(result: CommandResult) {
  switch (result.status) {
    case "AUTH_REQUIRED":
      return "Prihláste sa a skúste to znova.";
    case "NOT_FOUND":
      return "Táto zmena nie je dostupná.";
    case "CONFLICT":
      return "Revízia sa medzičasom zmenila. Obnovte stránku a skontrolujte presné znenie.";
    default:
      return "Zmenu sa nepodarilo uložiť. Skontrolujte údaje a skúste to znova.";
  }
}
function pdfErrorMessage(result: PdfWorkflowResult): string {
  if (result.status === "REJECTED")
    return "PDF neprešlo bezpečnostnou kontrolou. Vytvorte novú revíziu s opraveným súborom.";
  if (result.status === "EXPIRED")
    return "Rezervácia PDF vypršala alebo sa návrh medzičasom zmenil. Obnovte stránku a vytvorte novú revíziu.";
  if (result.status === "CONFLICT")
    return "Revízia sa medzičasom zmenila. Obnovte stránku a skontrolujte aktuálny návrh.";
  if (result.status === "NOT_FOUND")
    return "PDF ani návrh nie sú dostupné pre túto zákazku.";
  if (result.status === "AUTH_REQUIRED")
    return "Prihláste sa a skúste to znova.";
  return "PDF dodatok sa nepodarilo spracovať. Skúste to znova s novou revíziou.";
}
export function JobChangeOrders({
  jobId,
  role,
  jobState,
}: {
  jobId: string;
  role: Side;
  jobState: string;
}) {
  const [page, setPage] = useState<ChangePage | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [pdfPending, setPdfPending] = useState<PendingChangePdf | null>(null),
    [pdfProgress, setPdfProgress] = useState("");
  const reload = () => {
    void loadChangeOrders(fetch, jobId).then((result) => {
      if (result.status === "OK") {
        setPage(result.value);
        setError("");
      } else
        setError(
          result.status === "NOT_FOUND"
            ? "Zmeny zákazky nie sú dostupné."
            : "Zmeny sa nepodarilo načítať.",
        );
    });
  };
  useEffect(reload, [jobId]);
  const handlePdf = (result: PdfWorkflowResult) => {
    if (result.status === "OK") {
      setPdfPending(null);
      setPdfProgress("");
      setCreate(false);
      reload();
    } else if (result.status === "PROCESSING") {
      setPdfPending(result.pending);
      setPdfProgress(
        "PDF sa ešte spracúva. Návrh zatiaľ nie je vytvorený; stav môžete skontrolovať znova.",
      );
    } else {
      setPdfPending(null);
      setPdfProgress("");
      setError(pdfErrorMessage(result));
    }
  };
  const submit = async (terms: ChangeTerms, file: File | null) => {
    setBusy(true);
    setError("");
    const commandId = crypto.randomUUID();
    const command: PdfChangeCommand = {
      kind: "CREATE",
      revisionId: crypto.randomUUID(),
      terms,
    };
    if (file !== null) {
      if (role !== "PRIMARY_PROVIDER") {
        setBusy(false);
        setError("PDF dodatok môže pripojiť iba hlavný poskytovateľ.");
        return;
      }
      const pdf = await startChangePdf(
        fetch,
        jobId,
        commandId,
        command,
        file,
        setPdfProgress,
      );
      setBusy(false);
      handlePdf(pdf);
      return;
    }
    const result = await sendChangeCommand(fetch, jobId, commandId, command);
    setBusy(false);
    if (result.status === "OK") {
      setCreate(false);
      reload();
    } else setError(errorMessage(result));
  };
  return (
    <section aria-labelledby="job-change-orders">
      <h2 id="job-change-orders">Zmeny dohody</h2>
      <p>
        Vaša zmluvná strana: {sideName(role)}. Pôvodná dohoda zostáva nezmenená.
        Návrh nemení cenu, rozsah ani termín, kým ho druhá strana neschváli.
      </p>
      {error && <p role="alert">{error}</p>}
      {pdfProgress && <p role="status">{pdfProgress}</p>}
      {pdfPending && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              handlePdf(
                await resumeChangePdf(fetch, pdfPending, setPdfProgress),
              );
              setBusy(false);
            })();
          }}
        >
          Skontrolovať stav PDF a dokončiť návrh
        </button>
      )}
      {page && (
        <>
          <h3>Schválené zmeny</h3>
          {page.items.filter((item) => item.state === "APPROVED").length ===
          0 ? (
            <p>Zatiaľ žiadne schválené zmeny.</p>
          ) : (
            <ul>
              {page.items
                .filter((item) => item.state === "APPROVED")
                .map((item) => (
                  <li key={item.changeOrderId}>
                    <Link
                      href={`/zakazky/${jobId}/zmeny/${item.changeOrderId}/revizie/${item.revisionId}`}
                    >
                      {item.title} · revízia {item.revisionNumber}
                    </Link>
                  </li>
                ))}
            </ul>
          )}
          <h3>Čakajúce a ostatné návrhy</h3>
          {page.items.filter((item) => item.state !== "APPROVED").length ===
          0 ? (
            <p>Žiadne návrhy.</p>
          ) : (
            <ul>
              {page.items
                .filter((item) => item.state !== "APPROVED")
                .map((item) => (
                  <li key={item.changeOrderId}>
                    <Link
                      href={`/zakazky/${jobId}/zmeny/${item.changeOrderId}/revizie/${item.revisionId}`}
                    >
                      {item.title} · revízia {item.revisionNumber}
                    </Link>{" "}
                    — {stateName[item.state]}; autor:{" "}
                    {sideName(item.authoredSide)}
                  </li>
                ))}
            </ul>
          )}
          {page.nextCursor && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  const next = await loadChangeOrders(
                    fetch,
                    jobId,
                    page.nextCursor,
                  );
                  setBusy(false);
                  if (next.status === "OK")
                    setPage({
                      items: [...page.items, ...next.value.items],
                      nextCursor: next.value.nextCursor,
                    });
                  else setError("Ďalšie zmeny sa nepodarilo načítať.");
                })();
              }}
            >
              Načítať ďalšie zmeny
            </button>
          )}
        </>
      )}
      {(jobState === "CONFIRMED" || jobState === "IN_PROGRESS") && (
        <>
          <button type="button" onClick={() => setCreate(!create)}>
            {create ? "Zrušiť nový návrh" : "Pripraviť nový návrh zmeny"}
          </button>
          {create && (
            <ChangeTermsForm
              busy={busy || pdfPending !== null}
              allowPdf={role === "PRIMARY_PROVIDER"}
              submitLabel="Uložiť súkromný návrh"
              onSave={(terms, file) => {
                void submit(terms, file);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
export function JobChangeRevisionDetail({
  jobId,
  changeOrderId,
  revisionId,
}: {
  jobId: string;
  changeOrderId: string;
  revisionId: string;
}) {
  const [revision, setRevision] = useState<ChangeRevision | null>(null),
    [detail, setDetail] = useState<ChangeDetail | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [role, setRole] = useState<Side | null>(null),
    [pdfPending, setPdfPending] = useState<PendingChangePdf | null>(null),
    [pdfProgress, setPdfProgress] = useState("");
  const reload = () => {
    void Promise.all([
      loadExactRevision(fetch, jobId, changeOrderId, revisionId),
      loadChangeDetail(fetch, jobId, changeOrderId),
    ]).then(([rev, det]) => {
      if (
        rev.status === "OK" &&
        det.status === "OK" &&
        det.value.revisions.some(
          (item) => item.revisionId === rev.value.revisionId,
        )
      ) {
        setRevision(rev.value);
        setDetail(det.value);
        setError("");
      } else
        setError(
          rev.status === "NOT_FOUND" || det.status === "NOT_FOUND"
            ? "Táto revízia nie je dostupná."
            : "Revíziu sa nepodarilo načítať.",
        );
    });
  };
  useEffect(reload, [jobId, changeOrderId, revisionId]);
  useEffect(() => {
    void fetch(`/v1/me/jobs/${jobId}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (r) => {
        if (!r.ok) return;
        const value = parseJobDashboard(await r.json(), jobId);
        if (value) setRole(value.role);
      })
      .catch(() => undefined);
  }, [jobId]);
  const finish = (result: CommandResult & { status: "OK" }) =>
    window.location.assign(
      `/zakazky/${jobId}/zmeny/${result.changeOrderId}/revizie/${result.revisionId}`,
    );
  const handlePdf = (result: PdfWorkflowResult) => {
    if (result.status === "OK") finish(result.result);
    else if (result.status === "PROCESSING") {
      setPdfPending(result.pending);
      setPdfProgress(
        "PDF sa ešte spracúva. Revízia zatiaľ nie je vytvorená; stav môžete skontrolovať znova.",
      );
    } else {
      setPdfPending(null);
      setPdfProgress("");
      setError(pdfErrorMessage(result));
    }
  };
  const action = async (command: ChangeCommand, file: File | null = null) => {
    setBusy(true);
    setError("");
    const commandId = crypto.randomUUID();
    if (file !== null) {
      if (
        role !== "PRIMARY_PROVIDER" ||
        !(command.kind === "REPLACE" || command.kind === "COUNTERPROPOSE")
      ) {
        setBusy(false);
        setError("PDF dodatok môže pripojiť iba hlavný poskytovateľ.");
        return;
      }
      const pdf = await startChangePdf(
        fetch,
        jobId,
        commandId,
        command,
        file,
        setPdfProgress,
      );
      setBusy(false);
      handlePdf(pdf);
      return;
    }
    const result = await sendChangeCommand(fetch, jobId, commandId, command);
    setBusy(false);
    if (result.status === "OK") finish(result);
    else setError(errorMessage(result));
  };
  const head = detail?.revisions.reduce<ChangeRevision | null>(
    (latest, item) =>
      latest === null || item.revisionNumber > latest.revisionNumber
        ? item
        : latest,
    null,
  );
  const current = head?.revisionId === revisionId;
  const mine = role !== null && role === revision?.authoredSide;
  return (
    <article className="job-dashboard">
      <p>
        <Link href={`/zakazky/${jobId}`}>Späť na zákazku</Link>
      </p>
      <h1>Zmena dohody · revízia {revision?.revisionNumber ?? ""}</h1>
      {error && <p role="alert">{error}</p>}
      {pdfProgress && <p role="status">{pdfProgress}</p>}
      {pdfPending && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              handlePdf(
                await resumeChangePdf(fetch, pdfPending, setPdfProgress),
              );
              setBusy(false);
            })();
          }}
        >
          Skontrolovať stav PDF a dokončiť revíziu
        </button>
      )}
      {revision && (
        <>
          <p>
            Stav: {stateName[revision.state]}. Autor návrhu:{" "}
            {sideName(revision.authoredSide)}.
          </p>
          <p>
            Vytvorená: {new Date(revision.createdAt).toLocaleString("sk-SK")}
          </p>
          <ChangeTermsView terms={revision.terms} />
          <p>
            Toto je presné znenie revízie. Súhlas platí len pre túto revíziu;
            správa ani pracovný míľnik ju neschvaľujú.
          </p>
          {current && revision.state === "DRAFT" && mine && (
            <>
              <button type="button" onClick={() => setEditing(!editing)}>
                {editing ? "Zrušiť úpravu" : "Upraviť návrh ako novú revíziu"}
              </button>
              {editing && (
                <ChangeTermsForm
                  initial={revision.terms}
                  busy={busy || pdfPending !== null}
                  allowPdf={role === "PRIMARY_PROVIDER"}
                  submitLabel="Uložiť novú súkromnú revíziu"
                  onSave={(terms, file) =>
                    void action(
                      {
                        kind: "REPLACE",
                        changeOrderId,
                        expectedRevisionId: revisionId,
                        terms,
                      },
                      file,
                    )
                  }
                />
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action({
                    kind: "PROPOSE",
                    changeOrderId,
                    revisionId,
                    revisionNumber: revision.revisionNumber,
                  })
                }
              >
                Odoslať návrh druhej strane
              </button>
            </>
          )}
          {current && revision.state === "PROPOSED" && mine && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action({
                  kind: "WITHDRAW",
                  changeOrderId,
                  revisionId,
                  revisionNumber: revision.revisionNumber,
                })
              }
            >
              Stiahnuť návrh
            </button>
          )}
          {current &&
            revision.state === "PROPOSED" &&
            role === otherSide(revision.authoredSide) && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Schváliť presne túto revíziu zmeny dohody?",
                      )
                    )
                      void action({
                        kind: "APPROVE",
                        changeOrderId,
                        revisionId,
                        revisionNumber: revision.revisionNumber,
                      });
                  }}
                >
                  Schváliť túto revíziu
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action({
                      kind: "REJECT",
                      changeOrderId,
                      revisionId,
                      revisionNumber: revision.revisionNumber,
                    })
                  }
                >
                  Zamietnuť
                </button>
                <button type="button" onClick={() => setEditing(!editing)}>
                  {editing ? "Zrušiť protinávrh" : "Pripraviť protinávrh"}
                </button>
                {editing && (
                  <>
                    <p>
                      Odoslanie protinávrhu ho hneď predloží druhej strane a
                      nahradí aktuálnu revíziu.
                    </p>
                    <ChangeTermsForm
                      initial={revision.terms}
                      busy={busy || pdfPending !== null}
                      allowPdf={role === "PRIMARY_PROVIDER"}
                      submitLabel="Odoslať protinávrh"
                      onSave={(terms, file) =>
                        void action(
                          {
                            kind: "COUNTERPROPOSE",
                            changeOrderId,
                            expectedRevisionId: revisionId,
                            terms,
                          },
                          file,
                        )
                      }
                    />
                  </>
                )}
              </>
            )}
        </>
      )}
      {detail && (
        <section>
          <h2>História revízií</h2>
          <ol>
            {[...detail.revisions]
              .sort((a, b) => a.revisionNumber - b.revisionNumber)
              .map((item) => (
                <li key={item.revisionId}>
                  <Link
                    href={`/zakazky/${jobId}/zmeny/${changeOrderId}/revizie/${item.revisionId}`}
                  >
                    Revízia {item.revisionNumber}: {item.terms.title}
                  </Link>{" "}
                  · {stateName[item.state]} · {sideName(item.authoredSide)}
                </li>
              ))}
          </ol>
          <h3>Rozhodnutia</h3>
          {detail.actions.length === 0 ? (
            <p>Zatiaľ žiadne rozhodnutia.</p>
          ) : (
            <ol>
              {detail.actions.map((item) => (
                <li key={item.id}>
                  {item.action === "APPROVE"
                    ? "Schválenie"
                    : item.action === "REJECT"
                      ? "Zamietnutie"
                      : item.action === "WITHDRAW"
                        ? "Stiahnutie"
                        : item.action === "SUPERSEDE"
                          ? "Nahradenie revízie"
                          : "Odoslanie návrhu"}{" "}
                  · {new Date(item.occurredAt).toLocaleString("sk-SK")}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </article>
  );
}
