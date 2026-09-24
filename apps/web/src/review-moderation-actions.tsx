"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  loadOwnerReviewResponse,
  moderationReportReasons,
  type ModerationReportReason,
  type ModerationReportTargetType,
  type OwnerReviewResponse,
  submitModerationReport,
  submitOwnerReviewResponse,
} from "./review-response-report-data";

export function ReviewReportButton({
  targetId,
  targetType,
  label = "Nahlásiť",
}: {
  readonly targetId: string;
  readonly targetType: ModerationReportTargetType;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ModerationReportReason>(
    "PERSONAL_DATA_PRIVACY",
  );
  const [details, setDetails] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ intent: string; commandId: string } | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const normalized = details.trim();
    const intent = JSON.stringify({ reason, normalized, targetId, targetType });
    if (retry.current?.intent !== intent)
      retry.current = { intent, commandId: crypto.randomUUID() };
    setPending(true);
    setNotice("");
    const result = await submitModerationReport({
      fetch: globalThis.fetch,
      commandId: retry.current.commandId,
      targetType,
      targetId,
      reason,
      details: normalized,
    });
    if (result.status === "OK" || result.status === "ALREADY_REPORTED") {
      retry.current = null;
      setOpen(false);
      setNotice(
        result.status === "OK"
          ? "Hlásenie bolo prijaté na manuálne posúdenie. Obsah sa automaticky neskryl."
          : "Tento obsah ste už nahlásili.",
      );
    } else {
      setNotice(
        result.status === "AUTH_REQUIRED"
          ? "Na nahlásenie sa najprv prihláste."
          : result.status === "NOT_FOUND"
            ? "Obsah už nie je dostupný na nahlásenie."
            : "Hlásenie sa nepodarilo bezpečne odoslať. Skúste to znova.",
      );
    }
    setPending(false);
  };

  return (
    <div className="review-moderation-action">
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {label}
      </button>
      {open && (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Dôvod hlásenia
            <select
              value={reason}
              onChange={(event) =>
                setReason(event.target.value as ModerationReportReason)
              }
            >
              {moderationReportReasons.map(([value, title]) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Doplnenie (nepovinné)
            <textarea
              maxLength={1_000}
              value={details}
              onChange={(event) => setDetails(event.target.value)}
            />
          </label>
          <button disabled={pending} type="submit">
            {pending ? "Odosielam…" : "Odoslať hlásenie"}
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export function ReviewResponseEditor({
  reviewId,
}: {
  readonly reviewId: string;
}) {
  const [load, setLoad] = useState<
    | { readonly status: "LOADING" }
    | {
        readonly status: "READY";
        readonly response: OwnerReviewResponse | null;
      }
    | { readonly status: "UNAVAILABLE" }
  >({ status: "LOADING" });
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ intent: string; commandId: string } | null>(null);

  useEffect(() => {
    let active = true;
    void loadOwnerReviewResponse({ fetch: globalThis.fetch, reviewId }).then(
      (result) => {
        if (!active) return;
        if (result.status === "OK") {
          setBody(result.response.body);
          setLoad({ status: "READY", response: result.response });
        } else if (result.status === "NONE") {
          setLoad({ status: "READY", response: null });
        } else {
          setLoad({ status: "UNAVAILABLE" });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [reviewId]);

  if (load.status === "LOADING")
    return <p role="status">Načítavam vašu verejnú odpoveď…</p>;
  if (load.status === "UNAVAILABLE")
    return <p role="alert">Odpoveď sa momentálne nedá bezpečne načítať.</p>;

  const expired =
    load.response !== null &&
    Date.now() >= Date.parse(load.response.editDeadline);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = body.trim();
    if (pending || expired || normalized.length < 1) return;
    const expectedVersion = load.response?.version ?? 0;
    const intent = JSON.stringify({ expectedVersion, normalized });
    if (retry.current?.intent !== intent)
      retry.current = { intent, commandId: crypto.randomUUID() };
    setPending(true);
    setNotice("");
    const result = await submitOwnerReviewResponse({
      fetch: globalThis.fetch,
      reviewId,
      commandId: retry.current.commandId,
      expectedVersion,
      body: normalized,
    });
    if (result.status === "OK") {
      retry.current = null;
      window.location.reload();
      return;
    }
    setNotice(
      result.status === "EDIT_LOCKED"
        ? "Krátke okno na úpravu odpovede už uplynulo."
        : result.status === "CONFLICT"
          ? "Odpoveď sa medzitým zmenila. Obnovte stránku."
          : result.status === "AUTH_REQUIRED"
            ? "Relácia sa skončila. Prihláste sa znova."
            : result.status === "NOT_FOUND"
              ? "Na túto recenziu nemôžete odpovedať."
              : "Odpoveď sa nepodarilo bezpečne uložiť.",
    );
    setPending(false);
  };

  return (
    <form
      className="review-response-editor"
      onSubmit={(event) => void submit(event)}
    >
      <h4>Verejná odpoveď na hodnotenie</h4>
      <p>
        Môžete pridať jednu vecnú odpoveď. Hodnotenie ani jeho známky sa tým
        nezmenia a zákazník nemôže pokračovať verejným vláknom.
      </p>
      <label>
        Text odpovede
        <textarea
          disabled={expired || pending}
          maxLength={2_000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <button
        disabled={expired || pending || body.trim().length < 1}
        type="submit"
      >
        {load.response === null ? "Zverejniť odpoveď" : "Uložiť úpravu"}
      </button>
      {load.response !== null && (
        <p>
          {expired
            ? "Odpoveď je uzamknutá."
            : `Upraviť ju môžete do ${new Date(load.response.editDeadline).toLocaleString("sk-SK")}.`}
        </p>
      )}
      {notice && <p role="alert">{notice}</p>}
    </form>
  );
}
