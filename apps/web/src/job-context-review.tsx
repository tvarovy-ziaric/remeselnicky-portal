"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  contextReviewCanBeSubmittedOrEdited,
  createJobContextReviewCommandId,
  dimensionsForContextTarget,
  type JobContextReviewPage,
  type JobContextReviewRating,
  type JobContextReviewRatings,
  type JobContextReviewTargetKind,
  type JobParticipantReviewTarget,
  type JobWorkGroupReviewTarget,
  loadJobContextReviews,
  submitJobContextReview,
  validJobContextReviewDraft,
} from "./job-context-review-data";

type ReviewTarget = JobParticipantReviewTarget | JobWorkGroupReviewTarget;

const dateTime = (value: string) =>
  new Intl.DateTimeFormat("sk-SK", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Bratislava",
  }).format(new Date(value));

const emptyRatings = (kind: JobContextReviewTargetKind) =>
  Object.fromEntries(
    dimensionsForContextTarget(kind).map(([key]) => [key, null]),
  ) as JobContextReviewRatings;

const roleLabels = Object.freeze({
  MEMBER: "člen/ka",
  LEAD: "vedúci/a",
  COORDINATOR: "koordinátor/ka",
  SITE_MANAGER: "stavbyvedúci/a",
} as const);

function ReviewContent({ target }: { target: ReviewTarget }) {
  if (target.review === null) return null;
  return (
    <div>
      <h4>Vaše posledné uložené hodnotenie</h4>
      <dl>
        {dimensionsForContextTarget(target.targetKind).map(([key, label]) => (
          <React.Fragment key={key}>
            <dt>{label}</dt>
            <dd>
              {target.review?.ratings[key] === null
                ? "Neviem posúdiť / netýka sa"
                : `${String(target.review?.ratings[key])} z 5`}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <p>
        {target.review.comment === null
          ? "Bez slovného komentára."
          : target.review.comment}
      </p>
      <p>
        Odoslané {dateTime(target.review.submittedAt)} · verzia{" "}
        {target.review.version}
      </p>
    </div>
  );
}

function ReviewEditor({
  jobId,
  target,
  submissionDeadline,
  now,
}: {
  jobId: string;
  target: ReviewTarget;
  submissionDeadline: string;
  now: number;
}) {
  const [ratings, setRatings] = useState<JobContextReviewRatings>(
    target.review?.ratings ?? emptyRatings(target.targetKind),
  );
  const [comment, setComment] = useState(target.review?.comment ?? "");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ intent: string; commandId: string } | null>(null);
  const editable = contextReviewCanBeSubmittedOrEdited(
    target,
    submissionDeadline,
    now,
  );
  if (!editable) return null;
  const valid = validJobContextReviewDraft(target.targetKind, ratings, comment);
  const targetId =
    target.targetKind === "PARTICIPANT"
      ? target.participantId
      : target.workGroupId;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !valid) return;
    const expectedVersion = target.review?.version ?? 0;
    const intent = JSON.stringify({ expectedVersion, ratings, comment });
    if (retry.current?.intent !== intent)
      retry.current = { intent, commandId: createJobContextReviewCommandId() };
    setPending(true);
    setNotice("");
    const result = await submitJobContextReview({
      fetch: globalThis.fetch,
      jobId,
      targetKind: target.targetKind,
      targetId,
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
        ? "Lehota na hodnotenie už uplynula."
        : result.status === "EDIT_LOCKED"
          ? "Lehota na úpravu tohto hodnotenia už uplynula."
          : result.status === "CONFLICT"
            ? "Hodnotenie sa medzitým zmenilo. Obnovte stránku."
            : result.status === "AUTH_REQUIRED"
              ? "Relácia sa skončila. Prihláste sa znova."
              : result.status === "NOT_FOUND"
                ? "Toto voliteľné hodnotenie už nie je dostupné."
                : "Hodnotenie sa nepodarilo bezpečne uložiť. Skúste to znova.",
    );
    setPending(false);
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={pending}>
        <legend>
          {target.review === null ? "Pridať hodnotenie" : "Upraviť hodnotenie"}
        </legend>
        <p>
          Ohodnoťte iba vlastnú skúsenosť z tejto dokončenej zákazky. Hodnotenie
          môže byť pozitívne, neutrálne alebo kritické.
        </p>
        {dimensionsForContextTarget(target.targetKind).map(([key, label]) => (
          <label key={key}>
            {label}
            <select
              aria-label={label}
              value={ratings[key] === null ? "NA" : String(ratings[key])}
              onChange={(event) => {
                const selected = event.target.value;
                setRatings({
                  ...ratings,
                  [key]:
                    selected === "NA"
                      ? null
                      : (Number(selected) as Exclude<
                          JobContextReviewRating,
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
        <label htmlFor={`context-review-comment-${targetId}`}>
          Slovný komentár (nepovinný)
        </label>
        <textarea
          id={`context-review-comment-${targetId}`}
          maxLength={2_000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
        {!Object.values(ratings).some((rating) => rating !== null) && (
          <p role="alert">Vyplňte aspoň jednu hodnotenú oblasť.</p>
        )}
        <button disabled={!valid || pending} type="submit">
          {target.review === null ? "Odoslať hodnotenie" : "Uložiť úpravu"}
        </button>
      </fieldset>
      {notice && <p role="alert">{notice}</p>}
    </form>
  );
}

function ParticipantTarget({
  jobId,
  target,
  submissionDeadline,
  now,
}: {
  jobId: string;
  target: JobParticipantReviewTarget;
  submissionDeadline: string;
  now: number;
}) {
  const editable = contextReviewCanBeSubmittedOrEdited(
    target,
    submissionDeadline,
    now,
  );
  return (
    <article aria-labelledby={`participant-review-${target.participantId}`}>
      <h3 id={`participant-review-${target.participantId}`}>
        {target.displayName}
      </h3>
      <p>
        {target.verifiedProfessionCodes.length === 0
          ? "Pri tejto zákazke nebola potvrdená konkrétna profesia."
          : `Overené profesie pri tejto zákazke: ${target.verifiedProfessionCodes.join(", ")}.`}
      </p>
      <p>
        Overené úlohy pri tejto zákazke:{" "}
        {target.verifiedRoles.map((role) => roleLabels[role]).join(", ")}.
      </p>
      <ReviewContent target={target} />
      {target.review !== null && editable && (
        <p>Upraviť môžete do {dateTime(target.review.editDeadline)}.</p>
      )}
      {target.review === null && !editable && <p>Lehota už uplynula.</p>}
      <ReviewEditor
        jobId={jobId}
        target={target}
        submissionDeadline={submissionDeadline}
        now={now}
      />
    </article>
  );
}

function WorkGroupTarget({
  jobId,
  target,
  submissionDeadline,
  now,
}: {
  jobId: string;
  target: JobWorkGroupReviewTarget;
  submissionDeadline: string;
  now: number;
}) {
  const editable = contextReviewCanBeSubmittedOrEdited(
    target,
    submissionDeadline,
    now,
  );
  return (
    <article aria-labelledby={`work-group-review-${target.workGroupId}`}>
      <h3 id={`work-group-review-${target.workGroupId}`}>{target.name}</h3>
      <p>Historická pracovná skupina, ktorá pracovala na tejto zákazke:</p>
      <ul>
        {target.members.map((member) => (
          <li key={member.assignmentId}>{member.displayName}</li>
        ))}
      </ul>
      <ReviewContent target={target} />
      {target.review !== null && editable && (
        <p>Upraviť môžete do {dateTime(target.review.editDeadline)}.</p>
      )}
      {target.review === null && !editable && <p>Lehota už uplynula.</p>}
      <ReviewEditor
        jobId={jobId}
        target={target}
        submissionDeadline={submissionDeadline}
        now={now}
      />
    </article>
  );
}

export function JobContextReviewView({
  page,
  now = Date.now(),
}: {
  page: JobContextReviewPage;
  now?: number;
}) {
  const [revealed, setRevealed] = useState(false);
  if (page.participants.length === 0 && page.workGroups.length === 0)
    return null;
  if (!revealed)
    return (
      <section aria-labelledby="job-context-review-heading">
        <h2 id="job-context-review-heading">Voliteľné hodnotenia</h2>
        <p>
          Jednotlivých remeselníkov a historické pracovné skupiny môžete
          hodnotiť samostatne. Každé hodnotenie je nepovinné.
        </p>
        <button type="button" onClick={() => setRevealed(true)}>
          Pokračovať k voliteľným hodnoteniam
        </button>
      </section>
    );
  return <JobContextReviewDetails page={page} now={now} />;
}

export function JobContextReviewDetails({
  page,
  now = Date.now(),
}: {
  page: JobContextReviewPage;
  now?: number;
}) {
  return (
    <section aria-labelledby="job-context-review-heading">
      <h2 id="job-context-review-heading">Voliteľné hodnotenia</h2>
      <p>
        Každý cieľ je nepovinný a hodnotí sa samostatne. Lehota je do{" "}
        {dateTime(page.submissionDeadline)}.
      </p>
      {page.participants.length > 0 && (
        <section aria-labelledby="participant-reviews-heading">
          <h3 id="participant-reviews-heading">Jednotliví remeselníci</h3>
          {page.participants.map((target) => (
            <ParticipantTarget
              key={target.participantId}
              jobId={page.jobId}
              target={target}
              submissionDeadline={page.submissionDeadline}
              now={now}
            />
          ))}
        </section>
      )}
      {page.workGroups.length > 0 && (
        <section aria-labelledby="work-group-reviews-heading">
          <h3 id="work-group-reviews-heading">Pracovné skupiny</h3>
          <p>
            Hodnotenie skupiny sa neprenáša na jednotlivých členov ani na dnešné
            zloženie skupiny.
          </p>
          {page.workGroups.map((target) => (
            <WorkGroupTarget
              key={target.workGroupId}
              jobId={page.jobId}
              target={target}
              submissionDeadline={page.submissionDeadline}
              now={now}
            />
          ))}
        </section>
      )}
    </section>
  );
}

export function JobContextReview({ jobId }: { jobId: string }) {
  const [load, setLoad] = useState<Awaited<
    ReturnType<typeof loadJobContextReviews>
  > | null>(null);
  useEffect(() => {
    let active = true;
    void loadJobContextReviews({ fetch: globalThis.fetch, jobId }).then(
      (result) => {
        if (active) setLoad(result);
      },
    );
    return () => {
      active = false;
    };
  }, [jobId]);
  if (load === null || load.status === "NOT_FOUND") return null;
  if (load.status === "AUTH_REQUIRED")
    return <p role="alert">Relácia sa skončila. Prihláste sa znova.</p>;
  if (load.status !== "OK")
    return (
      <p role="alert">
        Voliteľné hodnotenia sa nepodarilo bezpečne načítať. Skúste to znova
        neskôr.
      </p>
    );
  return <JobContextReviewView page={load.page} />;
}
