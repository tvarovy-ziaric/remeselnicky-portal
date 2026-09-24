"use client";

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import { loadJobDocumentPage, type JobDocumentItem } from "./job-documentation";
import {
  addJobDisputeEvidence,
  addJobDisputeStatement,
  confirmJobDisputeSettlement,
  createJobDisputeCommandId,
  jobDisputeCategories,
  loadJobDispute,
  loadJobDisputes,
  loadJobDisputeUploadStatus,
  openJobDispute,
  uploadJobDisputeEvidence,
  withdrawJobDispute,
  type JobDisputeCategory,
  type JobDisputeCommandResult,
  type JobDisputeDetail,
  type JobDisputeState,
  type JobDisputeSummary,
  type JobDisputeUploadResult,
} from "./job-dispute-data";

type Retry = { fingerprint: string; commandId: string } | null;
type PendingUpload = {
  readonly mediaAssetId: string;
  readonly description: string;
};

const categoryLabels = new Map<string, string>(jobDisputeCategories);
const stateLabels: Readonly<Record<JobDisputeState, string>> = Object.freeze({
  OPEN: "Otvorený",
  WAITING_FOR_PARTY: "Čaká na stranu",
  UNDER_REVIEW: "Preveruje sa",
  RESOLVED: "Vyriešený",
  CLOSED: "Uzavretý",
});
const roleLabel = (role: "CUSTOMER" | "PRIMARY_PROVIDER") =>
  role === "CUSTOMER" ? "Zákazník" : "Hlavný poskytovateľ";
const outcomeLabels = Object.freeze({
  RESOLVED_BY_PARTIES: "Dohoda strán",
  OPERATIONAL_ADMIN_RESOLUTION: "Prevádzkové administratívne riešenie",
  NO_ACTION: "Bez ďalšieho opatrenia",
  REFERRED_OUTSIDE_PLATFORM: "Odkázané mimo platformy",
  ACCOUNT_POLICY_ACTION: "Samostatné opatrenie podľa pravidiel platformy",
  OTHER: "Iný prevádzkový výsledok",
});
const caseActionLabels: Readonly<Record<string, string>> = Object.freeze({
  OPEN: "Prípad otvorený",
  START_REVIEW: "Začalo sa preverovanie",
  REQUEST_INFORMATION: "Vyžiadané doplnenie",
  RECORD_OUTCOME: "Zaznamenaný výsledok",
  CLOSE: "Prípad uzavretý",
  REOPEN: "Prípad znovu otvorený",
  WITHDRAW: "Prípad stiahnutý otvárajúcou stranou",
  CONFIRM_SETTLEMENT: "Dohodu potvrdili obe strany",
});

function retryId(ref: { current: Retry }, fingerprint: string) {
  if (ref.current?.fingerprint === fingerprint) return ref.current.commandId;
  const commandId = createJobDisputeCommandId();
  ref.current = { fingerprint, commandId };
  return commandId;
}

export function JobDisputes({ jobId }: { readonly jobId: string }) {
  const [cases, setCases] = useState<readonly JobDisputeSummary[] | null>(null);
  const [detail, setDetail] = useState<JobDisputeDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<readonly JobDocumentItem[]>([]);
  const [category, setCategory] =
    useState<JobDisputeCategory>("QUALITY_DEFECT");
  const [description, setDescription] = useState("");
  const [desiredResolution, setDesiredResolution] = useState("");
  const [statementKind, setStatementKind] = useState<"STATEMENT" | "ADDENDUM">(
    "STATEMENT",
  );
  const [statement, setStatement] = useState("");
  const [existingMediaAssetId, setExistingMediaAssetId] = useState("");
  const [existingDescription, setExistingDescription] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [settlementSummary, setSettlementSummary] = useState("");
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const openRetry = useRef<Retry>(null);
  const statementRetry = useRef<Retry>(null);
  const existingEvidenceRetry = useRef<Retry>(null);
  const uploadEvidenceRetry = useRef<Retry>(null);
  const settlementRetry = useRef<Retry>(null);
  const withdrawalRetry = useRef<Retry>(null);

  const refreshCases = async (preferredId?: string) => {
    const result = await loadJobDisputes({ fetch: globalThis.fetch, jobId });
    if (result.status !== "OK") {
      setFailed(true);
      return false;
    }
    setCases(result.value);
    setFailed(false);
    if (preferredId) setSelectedId(preferredId);
    return true;
  };

  const refreshDetail = async (disputeId: string) => {
    const result = await loadJobDispute({
      fetch: globalThis.fetch,
      jobId,
      disputeId,
    });
    if (result.status !== "OK") {
      setDetail(null);
      setNotice("Prípad sa nepodarilo bezpečne načítať.");
      return false;
    }
    setDetail(result.value);
    return true;
  };

  useEffect(() => {
    let active = true;
    void loadJobDisputes({ fetch: globalThis.fetch, jobId }).then((result) => {
      if (!active) return;
      if (result.status === "OK") {
        setCases(result.value);
        setFailed(false);
      } else setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [jobId]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDocuments([]);
      return;
    }
    let active = true;
    setDetail(null);
    setDocuments([]);
    void Promise.all([
      loadJobDispute({ fetch: globalThis.fetch, jobId, disputeId: selectedId }),
      loadJobDocumentPage({
        fetch: globalThis.fetch,
        jobId,
        category: "ALL",
      }),
    ]).then(([caseResult, documentPage]) => {
      if (!active) return;
      if (caseResult.status === "OK") setDetail(caseResult.value);
      else setNotice("Prípad sa nepodarilo bezpečne načítať.");
      setDocuments(documentPage?.items ?? []);
    });
    return () => {
      active = false;
    };
  }, [jobId, selectedId]);

  const openCase = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const normalizedDescription = description.trim();
    const normalizedResolution = desiredResolution.trim();
    if (normalizedDescription.length < 10 || normalizedResolution.length < 1) {
      setNotice("Doplňte opis aspoň na 10 znakov a požadované riešenie.");
      return;
    }
    setPending(true);
    setNotice("");
    const commandId = retryId(
      openRetry,
      JSON.stringify([category, normalizedDescription, normalizedResolution]),
    );
    const result = await openJobDispute({
      fetch: globalThis.fetch,
      jobId,
      commandId,
      category,
      description: normalizedDescription,
      desiredResolution: normalizedResolution,
    });
    if (result.status === "OK") {
      openRetry.current = null;
      setDescription("");
      setDesiredResolution("");
      setNotice(
        "Prípad bol bezpečne otvorený a protistrana dostala oznámenie.",
      );
      await refreshCases(result.disputeId);
    } else setNotice(commandNotice(result.status));
    setPending(false);
  };

  const addStatement = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail || pending || statement.trim().length < 1) return;
    setPending(true);
    setNotice("");
    const normalized = statement.trim();
    const result = await addJobDisputeStatement({
      fetch: globalThis.fetch,
      jobId,
      disputeId: detail.id,
      commandId: retryId(
        statementRetry,
        JSON.stringify([detail.id, statementKind, normalized]),
      ),
      kind: statementKind,
      body: normalized,
    });
    if (result.status === "OK") {
      statementRetry.current = null;
      setStatement("");
      setNotice("Vyjadrenie bolo pridané do nemennej histórie prípadu.");
      await refreshDetail(detail.id);
    } else setNotice(commandNotice(result.status));
    setPending(false);
  };

  const bindExistingEvidence = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !detail ||
      pending ||
      existingMediaAssetId.length === 0 ||
      existingDescription.trim().length < 1
    )
      return;
    setPending(true);
    setNotice("");
    const normalized = existingDescription.trim();
    const result = await addJobDisputeEvidence({
      fetch: globalThis.fetch,
      jobId,
      disputeId: detail.id,
      commandId: retryId(
        existingEvidenceRetry,
        JSON.stringify([detail.id, existingMediaAssetId, normalized]),
      ),
      source: "EXISTING_JOB_EVIDENCE",
      mediaAssetId: existingMediaAssetId,
      description: normalized,
    });
    if (result.status === "OK") {
      existingEvidenceRetry.current = null;
      setExistingMediaAssetId("");
      setExistingDescription("");
      setNotice("Existujúci dokument bol pripojený k prípadu bez kopírovania.");
      await refreshDetail(detail.id);
    } else setNotice(commandNotice(result.status));
    setPending(false);
  };

  const bindUploadedEvidence = async (upload: PendingUpload) => {
    if (!detail) return false;
    const status = await loadJobDisputeUploadStatus({
      fetch: globalThis.fetch,
      jobId,
      disputeId: detail.id,
      mediaAssetId: upload.mediaAssetId,
    });
    if (status.status !== "OK") {
      setNotice("Stav súkromného súboru sa nepodarilo overiť.");
      return false;
    }
    if (status.value.status === "REJECTED") {
      setPendingUpload(null);
      setNotice("Súbor neprešiel bezpečnostným spracovaním a nebol pripojený.");
      return false;
    }
    if (status.value.status !== "READY" || !status.value.canBind) {
      setNotice("Súbor sa ešte bezpečne spracúva. Skontrolujte ho o chvíľu.");
      return false;
    }
    const result = await addJobDisputeEvidence({
      fetch: globalThis.fetch,
      jobId,
      disputeId: detail.id,
      commandId: retryId(
        uploadEvidenceRetry,
        JSON.stringify([detail.id, upload.mediaAssetId, upload.description]),
      ),
      source: "NEW_UPLOAD",
      mediaAssetId: upload.mediaAssetId,
      description: upload.description,
    });
    if (result.status !== "OK") {
      setNotice(commandNotice(result.status));
      return false;
    }
    uploadEvidenceRetry.current = null;
    setPendingUpload(null);
    setUploadDescription("");
    setFile(null);
    setNotice(
      "Nový súbor bol po bezpečnostnom spracovaní pripojený k prípadu.",
    );
    await refreshDetail(detail.id);
    return true;
  };

  const uploadEvidence = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail || !file || pending || uploadDescription.trim().length < 1)
      return;
    setPending(true);
    setNotice("Súbor sa nahráva do súkromného spracovania…");
    const result = await uploadJobDisputeEvidence({
      fetch: globalThis.fetch,
      jobId,
      disputeId: detail.id,
      file,
    });
    if (result.status === "OK") {
      const upload = {
        mediaAssetId: result.assetId,
        description: uploadDescription.trim(),
      };
      setPendingUpload(upload);
      setNotice("Súbor sa bezpečne spracúva. Skontrolujte výsledok o chvíľu.");
    } else setNotice(uploadNotice(result.status));
    setPending(false);
  };

  const checkUpload = async () => {
    if (!pendingUpload || pending) return;
    setPending(true);
    await bindUploadedEvidence(pendingUpload);
    setPending(false);
  };

  const confirmSettlement = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail || pending || settlementSummary.trim().length < 8) return;
    setPending(true);
    setNotice("");
    const summary = settlementSummary.trim();
    const result = await confirmJobDisputeSettlement({
      fetch: globalThis.fetch,
      jobId,
      disputeId: detail.id,
      commandId: retryId(settlementRetry, JSON.stringify([detail.id, summary])),
      summary,
    });
    if (result.status === "OK") {
      settlementRetry.current = null;
      setNotice(
        "Vaše presné zhrnutie bolo potvrdené. Prípad sa vyrieši až po rovnakom potvrdení druhej strany.",
      );
      await refreshCases(detail.id);
      await refreshDetail(detail.id);
    } else setNotice(commandNotice(result.status));
    setPending(false);
  };

  const withdrawCase = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail || pending || !detail.canWithdraw) return;
    setPending(true);
    setNotice("");
    const reason = withdrawalReason.trim() || null;
    const result = await withdrawJobDispute({
      fetch: globalThis.fetch,
      jobId,
      disputeId: detail.id,
      commandId: retryId(withdrawalRetry, JSON.stringify([detail.id, reason])),
      reason,
    });
    if (result.status === "OK") {
      withdrawalRetry.current = null;
      setNotice("Prípad bol stiahnutý a historický záznam zostal zachovaný.");
      await refreshCases(detail.id);
      await refreshDetail(detail.id);
    } else setNotice(commandNotice(result.status));
    setPending(false);
  };

  return (
    <section aria-labelledby="job-disputes">
      <h2 id="job-disputes">Súkromné sporné prípady</h2>
      <p>
        Sporný prípad je oddelený od stavu zákazky. Jeho otvorenie nemení
        prijatú dohodu, platbu, hodnotenie ani stav zákazky a platforma tým
        nerozhoduje právny spor ani nepriznáva náhradu.
      </p>
      <p>
        Obsah vidí iba zákazník a hlavný poskytovateľ tejto zákazky. Každé
        vyjadrenie a pripojený dôkaz zostáva v histórii bez tichého prepisu.
      </p>

      <form onSubmit={(event) => void openCase(event)}>
        <fieldset disabled={pending}>
          <legend>Otvoriť nový prípad</legend>
          <label htmlFor={`dispute-category-${jobId}`}>Kategória</label>
          <select
            id={`dispute-category-${jobId}`}
            onChange={(event) =>
              setCategory(event.currentTarget.value as JobDisputeCategory)
            }
            value={category}
          >
            {jobDisputeCategories.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor={`dispute-description-${jobId}`}>Stručný opis</label>
          <textarea
            id={`dispute-description-${jobId}`}
            maxLength={4_000}
            minLength={10}
            onChange={(event) => setDescription(event.currentTarget.value)}
            required
            value={description}
          />
          <label htmlFor={`dispute-resolution-${jobId}`}>
            Aké riešenie požadujete
          </label>
          <textarea
            id={`dispute-resolution-${jobId}`}
            maxLength={2_000}
            minLength={1}
            onChange={(event) =>
              setDesiredResolution(event.currentTarget.value)
            }
            required
            value={desiredResolution}
          />
          <button type="submit">Otvoriť súkromný prípad</button>
        </fieldset>
      </form>

      <h3>Prípady tejto zákazky</h3>
      {cases === null && !failed && <p role="status">Načítavajú sa prípady…</p>}
      {cases?.length === 0 && <p>Zatiaľ nie je otvorený žiadny prípad.</p>}
      {cases && cases.length > 0 && (
        <ol>
          {cases.map((item) => (
            <li key={item.id}>
              <button
                aria-pressed={selectedId === item.id}
                onClick={() => setSelectedId(item.id)}
                type="button"
              >
                {categoryLabels.get(item.category)} · {stateLabels[item.state]}{" "}
                ·{" "}
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("sk-SK")}
                </time>
              </button>
            </li>
          ))}
        </ol>
      )}
      {failed && (
        <p role="alert">Sporné prípady sa nepodarilo bezpečne načítať.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {selectedId && detail === null && !notice && (
        <p role="status">Načítava sa detail prípadu…</p>
      )}
      {detail && (
        <>
          <JobDisputeDetailView
            detail={detail}
            documents={documents}
            existingDescription={existingDescription}
            existingMediaAssetId={existingMediaAssetId}
            file={file}
            onAddStatement={addStatement}
            onBindExisting={bindExistingEvidence}
            onCheckUpload={checkUpload}
            onExistingDescription={setExistingDescription}
            onExistingMediaAssetId={setExistingMediaAssetId}
            onFile={setFile}
            onStatement={setStatement}
            onStatementKind={setStatementKind}
            onUpload={uploadEvidence}
            onUploadDescription={setUploadDescription}
            pending={pending}
            pendingUpload={pendingUpload}
            statement={statement}
            statementKind={statementKind}
            uploadDescription={uploadDescription}
          />
          <JobDisputePartyActions
            detail={detail}
            onConfirmSettlement={confirmSettlement}
            onSettlementSummary={setSettlementSummary}
            onWithdraw={withdrawCase}
            onWithdrawalReason={setWithdrawalReason}
            pending={pending}
            settlementSummary={settlementSummary}
            withdrawalReason={withdrawalReason}
          />
        </>
      )}
    </section>
  );
}

export function JobDisputeDetailView({
  detail,
  documents,
  existingDescription,
  existingMediaAssetId,
  file,
  onAddStatement,
  onBindExisting,
  onCheckUpload,
  onExistingDescription,
  onExistingMediaAssetId,
  onFile,
  onStatement,
  onStatementKind,
  onUpload,
  onUploadDescription,
  pending,
  pendingUpload,
  statement,
  statementKind,
  uploadDescription,
}: {
  readonly detail: JobDisputeDetail;
  readonly documents: readonly JobDocumentItem[];
  readonly existingDescription: string;
  readonly existingMediaAssetId: string;
  readonly file: File | null;
  readonly onAddStatement: (event: React.FormEvent) => Promise<void>;
  readonly onBindExisting: (event: React.FormEvent) => Promise<void>;
  readonly onCheckUpload: () => Promise<void>;
  readonly onExistingDescription: (value: string) => void;
  readonly onExistingMediaAssetId: (value: string) => void;
  readonly onFile: (value: File | null) => void;
  readonly onStatement: (value: string) => void;
  readonly onStatementKind: (value: "STATEMENT" | "ADDENDUM") => void;
  readonly onUpload: (event: React.FormEvent) => Promise<void>;
  readonly onUploadDescription: (value: string) => void;
  readonly pending: boolean;
  readonly pendingUpload: PendingUpload | null;
  readonly statement: string;
  readonly statementKind: "STATEMENT" | "ADDENDUM";
  readonly uploadDescription: string;
}) {
  return (
    <article aria-labelledby={`dispute-${detail.id}`}>
      <h3 id={`dispute-${detail.id}`}>
        {categoryLabels.get(detail.category)} · {stateLabels[detail.state]}
      </h3>
      <p>
        Otvoril: {roleLabel(detail.openedByRole)} · revízia stavu{" "}
        {detail.stateRevision}
      </p>
      <p>{detail.description}</p>
      <p>
        <strong>Požadované riešenie:</strong> {detail.desiredResolution}
      </p>

      <h4>Postup prípadu</h4>
      <ol>
        {detail.caseTimeline.map((item) => (
          <li key={item.eventId}>
            {caseActionLabels[item.action] ?? item.action} ·{" "}
            {stateLabels[item.toState]} ·{" "}
            <time dateTime={item.occurredAt}>
              {new Date(item.occurredAt).toLocaleString("sk-SK")}
            </time>
          </li>
        ))}
      </ol>

      <h4>Požiadavky administrátora</h4>
      {detail.adminRequests.length === 0 ? (
        <p>Administrátor zatiaľ nepožiadal o doplnenie.</p>
      ) : (
        <ol>
          {detail.adminRequests.map((request) => (
            <li key={request.id}>
              <p>{request.requestText}</p>
              <p>
                Určené:{" "}
                {request.recipient === "BOTH"
                  ? "obe strany"
                  : roleLabel(request.recipient)}
                {request.replyDeadline && (
                  <>
                    {" "}
                    · prevádzkový termín{" "}
                    <time dateTime={request.replyDeadline}>
                      {new Date(request.replyDeadline).toLocaleString("sk-SK")}
                    </time>
                  </>
                )}
              </p>
              <p>
                Zmeškanie prevádzkového termínu samo osebe nerozhoduje spor ani
                právny nárok.
              </p>
            </li>
          ))}
        </ol>
      )}

      <h4>Výsledok prípadu</h4>
      {detail.outcome === null ? (
        <p>Výsledok ešte nebol zaznamenaný.</p>
      ) : (
        <div>
          <p>
            <strong>{outcomeLabels[detail.outcome.category]}</strong> ·{" "}
            {detail.outcome.basis === "MUTUAL_PARTY_AGREEMENT"
              ? "vzájomná dohoda strán"
              : "administratívne uzavretie prípadu"}
          </p>
          <p>{detail.outcome.summary}</p>
          <p>
            Toto je prevádzkový záznam platformy, nie právny rozsudok ani zmena
            prijatej dohody.
          </p>
        </div>
      )}

      <h4>Potvrdenia dohody strán</h4>
      {detail.settlementConfirmations.length === 0 ? (
        <p>Žiadna strana zatiaľ nepotvrdila spoločné zhrnutie.</p>
      ) : (
        <ol>
          {detail.settlementConfirmations.map((confirmation) => (
            <li key={confirmation.id}>
              <strong>{roleLabel(confirmation.confirmedByRole)}</strong>
              <p>{confirmation.summary}</p>
              <time dateTime={confirmation.confirmedAt}>
                {new Date(confirmation.confirmedAt).toLocaleString("sk-SK")}
              </time>
            </li>
          ))}
        </ol>
      )}

      <h4>Nemeniteľný obchodný základ</h4>
      <p>
        Prijaté zadanie revízia{" "}
        {detail.commercialBaseline.acceptedRequestContentRevision}, viditeľná
        verzia {detail.commercialBaseline.acceptedRequestVisibleVersion};
        prijatá ponuka revízia {detail.commercialBaseline.acceptedQuoteRevision}
        .
      </p>
      <p>
        <Link href={detail.commercialBaseline.jobDashboardPath}>
          Zobraziť prijatú dohodu v zákazke
        </Link>
        {detail.commercialBaseline.acceptedQuotePdfDownloadPath && (
          <>
            {" "}
            ·{" "}
            <a href={detail.commercialBaseline.acceptedQuotePdfDownloadPath}>
              Prijatá ponuka PDF
            </a>
          </>
        )}
      </p>
      {detail.commercialBaseline.approvedChanges.length === 0 ? (
        <p>Bez schválených zmien.</p>
      ) : (
        <ol>
          {detail.commercialBaseline.approvedChanges.map((change) => (
            <li key={change.revisionId}>
              <Link
                href={`/zakazky/${detail.jobId}/zmeny/${change.changeOrderId}/revizie/${change.revisionId}`}
              >
                {change.title} · revízia {change.revisionNumber}
              </Link>
              : {change.changeDescription}
            </li>
          ))}
        </ol>
      )}

      <h4>Vyjadrenia strán</h4>
      {detail.statements.length === 0 ? (
        <p>Zatiaľ bez vyjadrení.</p>
      ) : (
        <ol>
          {detail.statements.map((item) => (
            <li key={item.id}>
              <p>
                {roleLabel(item.authorRole)} ·{" "}
                {item.kind === "STATEMENT" ? "vyjadrenie" : "doplnenie"} ·{" "}
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("sk-SK")}
                </time>
              </p>
              <p>{item.body}</p>
            </li>
          ))}
        </ol>
      )}
      {detail.canAddContent && (
        <form onSubmit={(event) => void onAddStatement(event)}>
          <fieldset disabled={pending}>
            <legend>Pridať nemenné vyjadrenie</legend>
            <label htmlFor={`statement-kind-${detail.id}`}>Typ</label>
            <select
              id={`statement-kind-${detail.id}`}
              onChange={(event) =>
                onStatementKind(
                  event.currentTarget.value as "STATEMENT" | "ADDENDUM",
                )
              }
              value={statementKind}
            >
              <option value="STATEMENT">Vyjadrenie</option>
              <option value="ADDENDUM">Doplnenie</option>
            </select>
            <label htmlFor={`statement-body-${detail.id}`}>Text</label>
            <textarea
              id={`statement-body-${detail.id}`}
              maxLength={4_000}
              minLength={1}
              onChange={(event) => onStatement(event.currentTarget.value)}
              required
              value={statement}
            />
            <button type="submit">Pridať do histórie</button>
          </fieldset>
        </form>
      )}

      <h4>Dôkazy</h4>
      {detail.evidence.length === 0 ? (
        <p>Zatiaľ bez pripojených dôkazov.</p>
      ) : (
        <ol>
          {detail.evidence.map((item) => (
            <li key={item.id}>
              <a href={item.downloadPath}>
                {item.displayFilename ??
                  (item.kind === "PHOTO" ? "Fotografia" : "PDF dokument")}
              </a>
              {" · "}
              {roleLabel(item.submittedByRole)} · {item.description}
            </li>
          ))}
        </ol>
      )}
      {detail.canAddContent && (
        <>
          <form onSubmit={(event) => void onBindExisting(event)}>
            <fieldset disabled={pending || documents.length === 0}>
              <legend>Pripojiť existujúci dôkaz zo zákazky</legend>
              <label htmlFor={`existing-evidence-${detail.id}`}>Súbor</label>
              <select
                id={`existing-evidence-${detail.id}`}
                onChange={(event) =>
                  onExistingMediaAssetId(event.currentTarget.value)
                }
                required
                value={existingMediaAssetId}
              >
                <option value="">Vyberte fotografiu alebo PDF</option>
                {documents.map((item) => (
                  <option key={item.mediaAssetId} value={item.mediaAssetId}>
                    {item.displayFilename ??
                      (item.kind === "PHOTO" ? "Fotografia" : "PDF dokument")}
                  </option>
                ))}
              </select>
              <label htmlFor={`existing-description-${detail.id}`}>
                Čo súbor preukazuje
              </label>
              <textarea
                id={`existing-description-${detail.id}`}
                maxLength={1_000}
                minLength={1}
                onChange={(event) =>
                  onExistingDescription(event.currentTarget.value)
                }
                required
                value={existingDescription}
              />
              <button type="submit">Pripojiť k prípadu</button>
            </fieldset>
          </form>

          <form onSubmit={(event) => void onUpload(event)}>
            <fieldset disabled={pending || pendingUpload !== null}>
              <legend>Nahrať nový súkromný dôkaz</legend>
              <p>Fotografia najviac 15 MB alebo PDF najviac 25 MB.</p>
              <label htmlFor={`new-evidence-${detail.id}`}>Súbor</label>
              <input
                accept="image/jpeg,image/png,image/heic,image/heif,application/pdf"
                id={`new-evidence-${detail.id}`}
                onChange={(event) =>
                  onFile(event.currentTarget.files?.[0] ?? null)
                }
                required
                type="file"
              />
              <label htmlFor={`new-description-${detail.id}`}>
                Čo súbor preukazuje
              </label>
              <textarea
                id={`new-description-${detail.id}`}
                maxLength={1_000}
                minLength={1}
                onChange={(event) =>
                  onUploadDescription(event.currentTarget.value)
                }
                required
                value={uploadDescription}
              />
              <button disabled={file === null} type="submit">
                Nahrať a bezpečne spracovať
              </button>
            </fieldset>
          </form>
          {pendingUpload && (
            <button
              disabled={pending}
              onClick={() => void onCheckUpload()}
              type="button"
            >
              Skontrolovať spracovanie a pripojiť
            </button>
          )}
        </>
      )}

      <details>
        <summary>Časová os zákazky dostupná pre posúdenie</summary>
        <ol>
          {detail.jobTimeline.map((item) => (
            <li key={item.eventId}>
              {item.eventType} ·{" "}
              <time dateTime={item.occurredAt}>
                {new Date(item.occurredAt).toLocaleString("sk-SK")}
              </time>
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

export function JobDisputePartyActions({
  detail,
  onConfirmSettlement,
  onSettlementSummary,
  onWithdraw,
  onWithdrawalReason,
  pending,
  settlementSummary,
  withdrawalReason,
}: Readonly<{
  detail: JobDisputeDetail;
  onConfirmSettlement: (event: React.FormEvent) => Promise<void>;
  onSettlementSummary: (value: string) => void;
  onWithdraw: (event: React.FormEvent) => Promise<void>;
  onWithdrawalReason: (value: string) => void;
  pending: boolean;
  settlementSummary: string;
  withdrawalReason: string;
}>) {
  if (!detail.canAddContent) return null;
  return (
    <div className="dispute-party-actions">
      <form onSubmit={(event) => void onConfirmSettlement(event)}>
        <fieldset disabled={pending}>
          <legend>Potvrdiť vlastnú dohodu strán</legend>
          <p>
            Obe strany musia nezávisle potvrdiť úplne rovnaké stručné zhrnutie.
            Záznam nemení prijatú ponuku ani schválené zmeny.
          </p>
          <label htmlFor={`settlement-${detail.id}`}>Spoločné zhrnutie</label>
          <textarea
            id={`settlement-${detail.id}`}
            maxLength={2_000}
            minLength={8}
            onChange={(event) => onSettlementSummary(event.currentTarget.value)}
            required
            value={settlementSummary}
          />
          <button type="submit">Potvrdiť presné zhrnutie</button>
        </fieldset>
      </form>
      {detail.canWithdraw && (
        <form onSubmit={(event) => void onWithdraw(event)}>
          <fieldset disabled={pending}>
            <legend>Stiahnuť prípad</legend>
            <p>
              Stiahnutie je dostupné iba otvárajúcej strane, ak nie je nutné
              pokračovať v závažnom bezpečnostnom alebo pravidlovom preverovaní.
              História zostane zachovaná.
            </p>
            <label htmlFor={`withdrawal-${detail.id}`}>
              Poznámka k stiahnutiu (voliteľná)
            </label>
            <textarea
              id={`withdrawal-${detail.id}`}
              maxLength={1_000}
              onChange={(event) =>
                onWithdrawalReason(event.currentTarget.value)
              }
              value={withdrawalReason}
            />
            <button type="submit">Stiahnuť prípad</button>
          </fieldset>
        </form>
      )}
    </div>
  );
}

function commandNotice(
  status: Exclude<JobDisputeCommandResult["status"], "OK">,
) {
  switch (status) {
    case "AUTH_REQUIRED":
      return "Prihláste sa znova.";
    case "CASE_CLOSED":
      return "Prípad už neprijíma ďalší obsah.";
    case "DUPLICATE_EVIDENCE":
      return "Tento súbor už je k prípadu pripojený.";
    case "WITHDRAWAL_BLOCKED":
      return "Prípad teraz nemožno stiahnuť, pretože musí pokračovať závažné preverovanie.";
    case "CONFLICT":
      return "Príkaz koliduje s predchádzajúcim pokusom. Obnovte prípad.";
    case "NOT_FOUND":
      return "Prípad alebo zákazka nie sú dostupné.";
    default:
      return "Akciu sa nepodarilo bezpečne dokončiť. Skúste to znova.";
  }
}

function uploadNotice(status: Exclude<JobDisputeUploadResult["status"], "OK">) {
  switch (status) {
    case "AUTH_REQUIRED":
      return "Prihláste sa znova.";
    case "INVALID_FILE":
      return "Vyberte podporovanú fotografiu alebo PDF.";
    case "FILE_TOO_LARGE":
      return "Súbor presahuje povolenú veľkosť.";
    case "NOT_FOUND":
      return "Prípad nie je dostupný.";
    default:
      return "Súbor sa nepodarilo bezpečne nahrať.";
  }
}
