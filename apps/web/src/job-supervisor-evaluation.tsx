"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  createSupervisorEvaluationCommandId,
  loadReceivedSupervisorEvaluations,
  loadSupervisorEvaluationDetail,
  loadSupervisorEvaluations,
  type OwnSupervisorEvaluation,
  type ReceivedSupervisorEvaluation,
  type ReceivedSupervisorEvaluationPage,
  submitSupervisorEvaluation,
  supervisorEvaluationDimensions,
  type SupervisorEvaluationPage,
  type SupervisorEvaluationRating,
  type SupervisorEvaluationRatings,
  type SupervisorEvaluationTarget,
  type SupervisorRelationshipKind,
  type SupervisorVerifiedRole,
  validSupervisorEvaluationDraft,
} from "./job-supervisor-evaluation-data";
import { ReviewReportButton } from "./review-moderation-actions";

const emptyRatings = () =>
  Object.fromEntries(
    supervisorEvaluationDimensions.map(([key]) => [key, null]),
  ) as SupervisorEvaluationRatings;

const dateTime = (value: string) =>
  new Intl.DateTimeFormat("sk-SK", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Bratislava",
  }).format(new Date(value));

const relationshipLabels: Readonly<Record<SupervisorRelationshipKind, string>> =
  {
    PRIMARY_CONTRACTOR: "hlavný zhotoviteľ",
    LEAD: "vedúci skupiny",
    COORDINATOR: "koordinátor",
    SITE_MANAGER: "stavbyvedúci",
  };

const roleLabels: Readonly<Record<SupervisorVerifiedRole, string>> = {
  MEMBER: "člen",
  LEAD: "vedúci",
  COORDINATOR: "koordinátor",
  SITE_MANAGER: "stavbyvedúci",
};

function EvaluationContent({
  evaluation,
}: {
  evaluation: Pick<OwnSupervisorEvaluation, "ratings" | "comment">;
}) {
  return (
    <>
      <dl>
        {supervisorEvaluationDimensions.map(([key, label]) => (
          <React.Fragment key={key}>
            <dt>{label}</dt>
            <dd>
              {evaluation.ratings[key] === null
                ? "Neviem posúdiť / netýka sa"
                : `${String(evaluation.ratings[key])} z 5`}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <p>
        {evaluation.comment === null
          ? "Bez odborného komentára."
          : evaluation.comment}
      </p>
    </>
  );
}

function EvaluationEditor({
  page,
  target,
  now,
}: {
  page: SupervisorEvaluationPage;
  target: SupervisorEvaluationTarget;
  now: number;
}) {
  const [ratings, setRatings] = useState<SupervisorEvaluationRatings>(
    target.evaluation?.ratings ?? emptyRatings(),
  );
  const [comment, setComment] = useState(target.evaluation?.comment ?? "");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ intent: string; commandId: string } | null>(null);
  const editable =
    now < Date.parse(page.submissionDeadline) &&
    (target.evaluation === null ||
      now < Date.parse(target.evaluation.editDeadline));
  if (!editable) return null;
  const valid = validSupervisorEvaluationDraft(ratings, comment);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !valid) return;
    const expectedVersion = target.evaluation?.version ?? 0;
    const intent = JSON.stringify({ expectedVersion, ratings, comment });
    if (retry.current?.intent !== intent)
      retry.current = {
        intent,
        commandId: createSupervisorEvaluationCommandId(),
      };
    setPending(true);
    setNotice("");
    const result = await submitSupervisorEvaluation({
      fetch: globalThis.fetch,
      jobId: page.jobId,
      participantId: target.participantId,
      commandId: retry.current.commandId,
      expectedVersion,
      ratings,
      comment,
    });
    if (result.status === "OK") {
      retry.current = null;
      window.location.reload();
      return;
    }
    setNotice(
      result.status === "WINDOW_CLOSED"
        ? "Lehota na odborné hodnotenie už uplynula."
        : result.status === "EDIT_LOCKED"
          ? "Krátka lehota na úpravu už uplynula."
          : result.status === "CONFLICT"
            ? "Hodnotenie sa medzitým zmenilo. Obnovte stránku."
            : result.status === "AUTH_REQUIRED"
              ? "Relácia sa skončila. Prihláste sa znova."
              : result.status === "NOT_FOUND"
                ? "Oprávnenie na toto hodnotenie nie je dostupné."
                : "Hodnotenie sa nepodarilo bezpečne uložiť. Skúste to znova.",
    );
    setPending(false);
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={pending}>
        <legend>
          {target.evaluation === null
            ? "Odborné hodnotenie"
            : "Upraviť odborné hodnotenie"}
        </legend>
        <p>
          Hodnoťte iba prácu, ktorú ste pri tejto zákazke reálne koordinovali.
          Nejde o zákaznícku recenziu ani o verejný komentár.
        </p>
        {supervisorEvaluationDimensions.map(([key, label]) => (
          <label key={key}>
            {label}
            <select
              aria-label={`${label} — ${target.displayName}`}
              value={ratings[key] === null ? "NA" : String(ratings[key])}
              onChange={(event) => {
                const selected = event.target.value;
                setRatings({
                  ...ratings,
                  [key]:
                    selected === "NA"
                      ? null
                      : (Number(selected) as Exclude<
                          SupervisorEvaluationRating,
                          null
                        >),
                });
              }}
            >
              <option value="NA">Neviem posúdiť / netýka sa</option>
              {[1, 2, 3, 4, 5].map((rating) => (
                <option key={rating} value={rating}>
                  {rating} z 5
                </option>
              ))}
            </select>
          </label>
        ))}
        <label htmlFor={`supervisor-comment-${target.participantId}`}>
          Odborný komentár (nepovinný)
        </label>
        <textarea
          id={`supervisor-comment-${target.participantId}`}
          maxLength={2_000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
        {!Object.values(ratings).some((rating) => rating !== null) && (
          <p role="alert">Vyplňte aspoň jednu hodnotenú oblasť.</p>
        )}
        <button disabled={!valid || pending} type="submit">
          {target.evaluation === null
            ? "Odoslať odborné hodnotenie"
            : "Uložiť úpravu"}
        </button>
      </fieldset>
      {notice && <p role="alert">{notice}</p>}
    </form>
  );
}

function EvaluationTargetCard({
  page,
  target,
  now,
}: {
  page: SupervisorEvaluationPage;
  target: SupervisorEvaluationTarget;
  now: number;
}) {
  const canEdit =
    now < Date.parse(page.submissionDeadline) &&
    (target.evaluation === null ||
      now < Date.parse(target.evaluation.editDeadline));
  return (
    <article aria-labelledby={`supervisor-target-${target.participantId}`}>
      <h3 id={`supervisor-target-${target.participantId}`}>
        {target.displayName}
      </h3>
      <p>
        Oprávnenie: {relationshipLabels[target.relationshipKind]} · preukázaný
        pracovný prekryv {dateTime(target.overlapStartedAt)} –{" "}
        {dateTime(target.overlapEndedAt)}.
      </p>
      <p>
        Overené roly:{" "}
        {target.verifiedRoles.map((role) => roleLabels[role]).join(", ")}.
      </p>
      <p>
        Overené profesie pre túto zákazku:{" "}
        {target.verifiedProfessionCodes.length === 0
          ? "bez potvrdenej profesie"
          : target.verifiedProfessionCodes.join(", ")}
        .
      </p>
      {target.evaluation !== null && (
        <div>
          <h4>Vaše uložené odborné hodnotenie</h4>
          <EvaluationContent evaluation={target.evaluation} />
          <p>
            Odoslané {dateTime(target.evaluation.submittedAt)} · verzia{" "}
            {target.evaluation.version}
          </p>
          {canEdit && (
            <p>Upraviť môžete do {dateTime(target.evaluation.editDeadline)}.</p>
          )}
        </div>
      )}
      {target.evaluation === null && !canEdit && <p>Lehota už uplynula.</p>}
      <EvaluationEditor page={page} target={target} now={now} />
    </article>
  );
}

export function JobSupervisorEvaluationView({
  page,
  now = Date.now(),
}: {
  page: SupervisorEvaluationPage;
  now?: number;
}) {
  if (page.targets.length === 0) return null;
  return (
    <section aria-labelledby="supervisor-evaluation-heading">
      <h2 id="supervisor-evaluation-heading">Odborné hodnotenia účastníkov</h2>
      <p>
        Oprávnení vedúci môžu do {dateTime(page.submissionDeadline)} nezávisle
        ohodnotiť iba účastníkov s preukázaným pracovným prekryvom. Hodnotenie
        je hneď súkromne viditeľné hodnotenému a nie je zapečatenou zákazníckou
        recenziou.
      </p>
      {page.targets.map((target) => (
        <EvaluationTargetCard
          key={target.participantId}
          page={page}
          target={target}
          now={now}
        />
      ))}
    </section>
  );
}

export function JobSupervisorEvaluations({ jobId }: { jobId: string }) {
  const [load, setLoad] = useState<Awaited<
    ReturnType<typeof loadSupervisorEvaluations>
  > | null>(null);
  useEffect(() => {
    let active = true;
    void loadSupervisorEvaluations({ fetch: globalThis.fetch, jobId }).then(
      (result) => {
        if (active) setLoad(result);
      },
    );
    return () => {
      active = false;
    };
  }, [jobId]);
  if (load === null) return <p role="status">Načítavam odborné hodnotenia…</p>;
  if (load.status === "NOT_FOUND") return null;
  if (load.status !== "OK")
    return (
      <p role="alert">
        Odborné hodnotenia sa nepodarilo bezpečne načítať. Skúste to znova
        neskôr.
      </p>
    );
  return <JobSupervisorEvaluationView page={load.page} />;
}

function ReceivedEvaluationCard({
  evaluation,
}: {
  evaluation: ReceivedSupervisorEvaluation;
}) {
  return (
    <article aria-labelledby={`received-supervisor-${evaluation.evaluationId}`}>
      <h3 id={`received-supervisor-${evaluation.evaluationId}`}>
        Odborné hodnotenie od {evaluation.evaluatorDisplayName}
      </h3>
      <p>
        Vzťah pri zákazke: {relationshipLabels[evaluation.relationshipKind]} ·
        pracovný prekryv {dateTime(evaluation.overlapStartedAt)} –{" "}
        {dateTime(evaluation.overlapEndedAt)}.
      </p>
      <EvaluationContent evaluation={evaluation} />
      <p>
        Overené profesie:{" "}
        {evaluation.verifiedProfessionCodes.join(", ") ||
          "bez potvrdenej profesie"}
        .
      </p>
      <p>Odoslané {dateTime(evaluation.submittedAt)}.</p>
      <ReviewReportButton
        label="Nahlásiť odborné hodnotenie"
        targetId={evaluation.evaluationId}
        targetType="SUPERVISOR_EVALUATION"
      />
    </article>
  );
}

export function ReceivedSupervisorEvaluations({
  jobId,
  participantId,
}: {
  jobId: string;
  participantId: string;
}) {
  const [load, setLoad] = useState<Awaited<
    ReturnType<typeof loadReceivedSupervisorEvaluations>
  > | null>(null);
  useEffect(() => {
    let active = true;
    void loadReceivedSupervisorEvaluations({
      fetch: globalThis.fetch,
      jobId,
    }).then((result) => {
      if (active) setLoad(result);
    });
    return () => {
      active = false;
    };
  }, [jobId]);
  if (load === null)
    return <p role="status">Načítavam prijaté odborné hodnotenia…</p>;
  if (load.status === "NOT_FOUND") return null;
  if (load.status !== "OK")
    return (
      <p role="alert">
        Prijaté odborné hodnotenia sa nepodarilo bezpečne načítať.
      </p>
    );
  return (
    <ReceivedSupervisorEvaluationView
      page={load.page}
      participantId={participantId}
    />
  );
}

export function ReceivedSupervisorEvaluationView({
  page,
  participantId,
}: {
  page: ReceivedSupervisorEvaluationPage;
  participantId: string;
}) {
  const evaluations = page.evaluations.filter(
    (evaluation) => evaluation.targetParticipantId === participantId,
  );
  if (evaluations.length === 0) return null;
  return (
    <section aria-labelledby="received-supervisor-heading">
      <h2 id="received-supervisor-heading">Moje odborné hodnotenia</h2>
      <p>
        Tieto hodnotenia vidíte súkromne. Verejný profil nesmie zobraziť ich
        surové známky ani komentáre.
      </p>
      {evaluations.map((evaluation) => (
        <ReceivedEvaluationCard
          key={evaluation.evaluationId}
          evaluation={evaluation}
        />
      ))}
    </section>
  );
}

export function ReceivedSupervisorEvaluationDetail({
  jobId,
  evaluationId,
}: {
  jobId: string;
  evaluationId: string;
}) {
  const [load, setLoad] = useState<Awaited<
    ReturnType<typeof loadSupervisorEvaluationDetail>
  > | null>(null);
  useEffect(() => {
    let active = true;
    void loadSupervisorEvaluationDetail({
      fetch: globalThis.fetch,
      jobId,
      evaluationId,
    }).then((result) => {
      if (active) setLoad(result);
    });
    return () => {
      active = false;
    };
  }, [evaluationId, jobId]);
  if (load === null) return <p role="status">Načítavam odborné hodnotenie…</p>;
  if (load.status === "AUTH_REQUIRED")
    return <p role="alert">Najprv sa prihláste.</p>;
  if (load.status === "NOT_FOUND")
    return <p role="alert">Odborné hodnotenie nie je dostupné.</p>;
  if (load.status !== "OK")
    return (
      <p role="alert">Odborné hodnotenie sa nepodarilo bezpečne načítať.</p>
    );
  return (
    <section aria-labelledby="supervisor-evaluation-detail-heading">
      <h1 id="supervisor-evaluation-detail-heading">Odborné hodnotenie</h1>
      <p>
        Súkromný technický záznam z dokončenej zákazky. Surové známky ani
        komentár nie sú súčasťou verejného profilu.
      </p>
      <ReceivedEvaluationCard evaluation={load.evaluation} />
    </section>
  );
}
