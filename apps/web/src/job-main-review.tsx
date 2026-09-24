"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  createJobMainReviewCommandId,
  customerToProviderReviewDimensions,
  type JobMainReviewDirection,
  type JobMainReviewPage,
  type JobMainReviewRating,
  type JobMainReviewRatings,
  loadJobMainReview,
  providerToCustomerReviewDimensions,
  reviewCanBeSubmittedOrEdited,
  submitJobMainReview,
  validJobMainReviewDraft,
} from "./job-main-review-data";
import {
  ReviewReportButton,
  ReviewResponseEditor,
} from "./review-moderation-actions";

const dimensions = (direction: JobMainReviewDirection) =>
  direction === "CUSTOMER_TO_PROVIDER"
    ? customerToProviderReviewDimensions
    : providerToCustomerReviewDimensions;

const emptyRatings = (direction: JobMainReviewDirection) =>
  Object.fromEntries(
    dimensions(direction).map(([key]) => [key, null]),
  ) as JobMainReviewRatings;

const dateTime = (value: string) =>
  new Intl.DateTimeFormat("sk-SK", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Bratislava",
  }).format(new Date(value));

const directionTitle = (direction: JobMainReviewDirection) =>
  direction === "CUSTOMER_TO_PROVIDER"
    ? "Hodnotenie poskytovateľa"
    : "Hodnotenie zákazníka";

function ReviewContent({
  direction,
  ratings,
  comment,
}: {
  direction: JobMainReviewDirection;
  ratings: JobMainReviewRatings;
  comment: string | null;
}) {
  return (
    <>
      <dl>
        {dimensions(direction).map(([key, label]) => (
          <React.Fragment key={key}>
            <dt>{label}</dt>
            <dd>
              {ratings[key] === null
                ? "Neviem posúdiť / netýka sa"
                : `${String(ratings[key])} z 5`}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <p>{comment === null ? "Bez slovného komentára." : comment}</p>
    </>
  );
}

function ReviewEditor({ page, now }: { page: JobMainReviewPage; now: number }) {
  const [ratings, setRatings] = useState<JobMainReviewRatings>(
    page.ownReview?.ratings ?? emptyRatings(page.direction),
  );
  const [comment, setComment] = useState(page.ownReview?.comment ?? "");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ intent: string; commandId: string } | null>(null);
  const editable = reviewCanBeSubmittedOrEdited(page, now);
  if (!editable) return null;
  const valid = validJobMainReviewDraft(page.direction, ratings, comment);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !valid) return;
    const expectedVersion = page.ownReview?.version ?? 0;
    const intent = JSON.stringify({ expectedVersion, ratings, comment });
    if (retry.current?.intent !== intent)
      retry.current = { intent, commandId: createJobMainReviewCommandId() };
    setPending(true);
    setNotice("");
    const result = await submitJobMainReview({
      fetch: globalThis.fetch,
      jobId: page.jobId,
      commandId: retry.current.commandId,
      expectedVersion,
      direction: page.direction,
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
          ? "Hodnotenie sa už odomklo alebo uplynula lehota na úpravu."
          : result.status === "CONFLICT"
            ? "Hodnotenie sa medzitým zmenilo. Obnovte stránku."
            : result.status === "AUTH_REQUIRED"
              ? "Relácia sa skončila. Prihláste sa znova."
              : result.status === "NOT_FOUND"
                ? "Hodnotenie pre túto zákazku nie je dostupné."
                : "Hodnotenie sa nepodarilo bezpečne uložiť. Skúste to znova.",
    );
    setPending(false);
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={pending}>
        <legend>
          {page.ownReview === null
            ? directionTitle(page.direction)
            : "Upraviť vlastné hodnotenie"}
        </legend>
        {page.direction === "PROVIDER_TO_CUSTOMER" && (
          <p>
            Skúsenosť s dohodou a platbou uvádzate vy. Nejde o platformou
            overený údaj o zaplatení.
          </p>
        )}
        <p>
          Ohodnoťte iba vlastnú skúsenosť z tejto zákazky. Hodnotenie môže byť
          pozitívne, neutrálne alebo kritické.
        </p>
        {dimensions(page.direction).map(([key, label]) => (
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
                          JobMainReviewRating,
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
        <label htmlFor={`main-review-comment-${page.jobId}`}>
          Slovný komentár (nepovinný)
        </label>
        <textarea
          id={`main-review-comment-${page.jobId}`}
          maxLength={2_000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
        {!Object.values(ratings).some((rating) => rating !== null) && (
          <p role="alert">Vyplňte aspoň jednu hodnotenú oblasť.</p>
        )}
        <button disabled={!valid || pending} type="submit">
          {page.ownReview === null ? "Odoslať hodnotenie" : "Uložiť úpravu"}
        </button>
      </fieldset>
      {notice && <p role="alert">{notice}</p>}
    </form>
  );
}

export function JobMainReviewView({
  page,
  now = Date.now(),
}: {
  page: JobMainReviewPage;
  now?: number;
}) {
  const canEdit = reviewCanBeSubmittedOrEdited(page, now);
  const editDeadline =
    page.ownReview === null
      ? null
      : Math.min(
          Date.parse(page.submissionDeadline),
          Date.parse(page.ownReview.submittedAt) + 60 * 60 * 1_000,
        );
  return (
    <section aria-labelledby="job-main-review-heading">
      <h2 id="job-main-review-heading">Hodnotenie dokončenej zákazky</h2>
      <p>
        Lehota na odoslanie je do {dateTime(page.submissionDeadline)}. Druhá
        strana vaše hodnotenie neuvidí, kým neodošle vlastné hodnotenie alebo
        lehota neuplynie.
      </p>
      {page.state === "OPEN" && <p>Hodnotenie zatiaľ nebolo odoslané.</p>}
      {page.state === "SUBMITTED_SEALED" && (
        <p>
          Vaše hodnotenie je uložené a zapečatené. Na hodnotenie druhej strany
          čakáme.
        </p>
      )}
      {page.state === "UNLOCKED" && (
        <p>Hodnotenie je odomknuté; ďalšia vlastná úprava už nie je možná.</p>
      )}
      {page.state === "EXPIRED_UNSUBMITTED" && (
        <p>Lehota uplynula. Vlastné hodnotenie už nemožno odoslať.</p>
      )}
      {page.ownReview !== null && (
        <div aria-labelledby="own-main-review-heading">
          <h3 id="own-main-review-heading">Vaše posledné uložené hodnotenie</h3>
          <ReviewContent
            direction={page.direction}
            ratings={page.ownReview.ratings}
            comment={page.ownReview.comment}
          />
          <p>
            Odoslané {dateTime(page.ownReview.submittedAt)} · verzia{" "}
            {page.ownReview.version}
          </p>
          {canEdit && editDeadline !== null && (
            <p>
              Upraviť ho môžete najneskôr do{" "}
              {dateTime(new Date(editDeadline).toISOString())}; možnosť úpravy
              sa skončí skôr, ak sa hodnotenie odomkne.
            </p>
          )}
        </div>
      )}
      <ReviewEditor
        key={`${page.state}:${page.ownReview?.revisionId ?? "new"}`}
        page={page}
        now={now}
      />
      {page.counterpartyReview !== null && (
        <div aria-labelledby="counterparty-main-review-heading">
          <h3 id="counterparty-main-review-heading">
            {directionTitle(page.counterpartyReview.direction)} od druhej strany
          </h3>
          <ReviewContent
            direction={page.counterpartyReview.direction}
            ratings={page.counterpartyReview.ratings}
            comment={page.counterpartyReview.comment}
          />
          <p>Odomknuté {dateTime(page.counterpartyReview.unlockedAt)}</p>
          {page.counterpartyReview.direction === "CUSTOMER_TO_PROVIDER" && (
            <>
              <ReviewReportButton
                label="Nahlásiť hodnotenie"
                targetId={page.counterpartyReview.revisionId}
                targetType="MAIN_REVIEW"
              />
              <ReviewResponseEditor
                reviewId={page.counterpartyReview.revisionId}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function JobMainReview({ jobId }: { jobId: string }) {
  const [load, setLoad] = useState<Awaited<
    ReturnType<typeof loadJobMainReview>
  > | null>(null);
  useEffect(() => {
    let active = true;
    void loadJobMainReview({ fetch: globalThis.fetch, jobId }).then(
      (result) => {
        if (active) setLoad(result);
      },
    );
    return () => {
      active = false;
    };
  }, [jobId]);
  if (load === null)
    return <p role="status">Načítava sa možnosť hodnotenia…</p>;
  if (load.status === "NOT_FOUND") return null;
  if (load.status !== "OK")
    return (
      <p role="alert">
        Hodnotenie sa nepodarilo bezpečne načítať. Skúste to znova neskôr.
      </p>
    );
  return <JobMainReviewView page={load.page} />;
}
