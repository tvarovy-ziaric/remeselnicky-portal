"use client";

import { useCallback, useEffect, useState } from "react";

interface ReportItem {
  readonly reportId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly state:
    "OPEN" | "UNDER_REVIEW" | "ACTIONED" | "NO_VIOLATION" | "CLOSED";
  readonly reportedAt: string;
}
interface ReportDetail extends ReportItem {
  readonly reporterUserId: string;
  readonly details: string | null;
}
interface AppealItem {
  readonly appealId: string;
  readonly actionId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly state: "OPEN" | "UPHELD" | "REDUCED" | "REVERSED";
  readonly submittedAt: string;
}
interface AppealDetail extends AppealItem {
  readonly appellantUserId: string;
  readonly explanation: string;
}

export function AdminModerationWorkspace() {
  const [reports, setReports] = useState<readonly ReportItem[]>([]);
  const [appeals, setAppeals] = useState<readonly AppealItem[]>([]);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [appeal, setAppeal] = useState<AppealDetail | null>(null);
  const [accessReason, setAccessReason] = useState("");
  const [commandReason, setCommandReason] = useState("");
  const [policyCategory, setPolicyCategory] = useState("INAPPROPRIATE_CONTENT");
  const [policyReasonCode, setPolicyReasonCode] = useState("POLICY_VIOLATION");
  const [policyVersion, setPolicyVersion] = useState("ALPHA-1");
  const [subjectUserId, setSubjectUserId] = useState("");
  const [userFacingReason, setUserFacingReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [reportResponse, appealResponse] = await Promise.all([
        fetch("/v1/admin/moderation/reports?limit=100", {
          cache: "no-store",
          credentials: "same-origin",
        }),
        fetch("/v1/admin/moderation/appeals?limit=100", {
          cache: "no-store",
          credentials: "same-origin",
        }),
      ]);
      const reportItems = reportResponse.ok
        ? parseReports(await reportResponse.json())
        : null;
      const appealItems = appealResponse.ok
        ? parseAppeals(await appealResponse.json())
        : null;
      if (reportItems === null || appealItems === null)
        throw new Error("invalid moderation queue");
      setReports(reportItems);
      setAppeals(appealItems);
    } catch {
      setNotice("Frontu moderovania sa nepodarilo načítať.");
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function accessReport(item: ReportItem) {
    if (accessReason.trim().length < 8) {
      setNotice("Uveďte konkrétny interný dôvod prístupu.");
      return;
    }
    setBusy(true);
    try {
      const response = await post(
        `/v1/admin/moderation/reports/${item.reportId}/access`,
        { accessId: crypto.randomUUID(), reason: accessReason.trim() },
      );
      const parsed = response.ok
        ? parseReportDetail(await response.json())
        : null;
      if (parsed === null) throw new Error("invalid detail");
      setDetail(parsed);
      setAppeal(null);
      setNotice("Citlivý prístup bol zapísaný do auditu.");
    } catch {
      setNotice("Detail hlásenia nie je dostupný.");
    } finally {
      setBusy(false);
    }
  }

  async function accessAppeal(item: AppealItem) {
    if (accessReason.trim().length < 8) {
      setNotice("Uveďte konkrétny interný dôvod prístupu.");
      return;
    }
    setBusy(true);
    try {
      const response = await post(
        `/v1/admin/moderation/appeals/${item.appealId}/access`,
        { accessId: crypto.randomUUID(), reason: accessReason.trim() },
      );
      const parsed = response.ok
        ? parseAppealDetail(await response.json())
        : null;
      if (parsed === null) throw new Error("invalid appeal detail");
      setAppeal(parsed);
      setDetail(null);
      setNotice("Citlivý prístup bol zapísaný do auditu.");
    } catch {
      setNotice("Detail odvolania nie je dostupný.");
    } finally {
      setBusy(false);
    }
  }

  async function workflow(path: string) {
    if (!detail || commandReason.trim().length < 8) return;
    await execute(`/v1/admin/moderation/reports/${detail.reportId}/${path}`, {
      commandId: crypto.randomUUID(),
      expectedState: detail.state,
      reason: commandReason.trim(),
    });
  }

  async function noViolation() {
    if (!detail || !validDecisionFields()) return;
    await execute(
      `/v1/admin/moderation/reports/${detail.reportId}/no-violation`,
      {
        commandId: crypto.randomUUID(),
        expectedState: detail.state,
        reason: commandReason.trim(),
        policyCategory,
        policyReasonCode,
        policyVersion,
      },
    );
  }

  async function hideContent() {
    if (
      !detail ||
      !validDecisionFields() ||
      !uuid(subjectUserId) ||
      userFacingReason.trim().length < 8
    )
      return;
    await execute(
      `/v1/admin/moderation/reports/${detail.reportId}/actions/hide-content`,
      {
        commandId: crypto.randomUUID(),
        expectedState: detail.state,
        reason: commandReason.trim(),
        policyCategory,
        policyReasonCode,
        policyVersion,
        subjectUserId,
        enforcementScope: "CONTENT",
        userFacingReason: userFacingReason.trim(),
        priorState: { visibility: "VISIBLE" },
      },
    );
  }

  async function decideAppeal(decision: "uphold" | "reverse") {
    if (!appeal || !validDecisionFields() || userFacingReason.trim().length < 8)
      return;
    await execute(
      `/v1/admin/moderation/appeals/${appeal.appealId}/${decision}`,
      {
        commandId: crypto.randomUUID(),
        expectedState: "OPEN",
        reason: commandReason.trim(),
        policyReasonCode,
        policyVersion,
        userFacingReason: userFacingReason.trim(),
      },
    );
  }

  async function execute(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await post(path, body);
      if (!response.ok) throw new Error("command failed");
      setNotice("Operácia bola bezpečne zapísaná.");
      setDetail(null);
      setAppeal(null);
      await reload();
    } catch {
      setNotice("Operáciu sa nepodarilo vykonať. Overte stav a recent MFA.");
    } finally {
      setBusy(false);
    }
  }

  function validDecisionFields() {
    return (
      commandReason.trim().length >= 8 &&
      /^[A-Z][A-Z0-9_.:-]{2,95}$/u.test(policyCategory) &&
      /^[A-Z][A-Z0-9_.:-]{2,95}$/u.test(policyReasonCode) &&
      /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/u.test(policyVersion)
    );
  }

  return (
    <section className="admin-panel" aria-labelledby="admin-moderation-title">
      <p className="admin-kicker">Manuálne posúdenie</p>
      <h2 id="admin-moderation-title">Hlásenia a odvolania</h2>
      <p>
        Počet hlásení nie je verdikt. Každé rozhodnutie vyžaduje dôvod, verziu
        pravidiel a recent MFA.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      <label>
        Dôvod citlivého prístupu
        <input
          value={accessReason}
          onChange={(event) => setAccessReason(event.target.value)}
        />
      </label>
      <div className="admin-ops-grid">
        <section>
          <h3>Hlásenia</h3>
          <ul className="admin-list">
            {reports.map((item) => (
              <li key={item.reportId}>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void accessReport(item)}
                >
                  {item.reason} · {item.targetType} · {item.state}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>Odvolania</h3>
          <ul className="admin-list">
            {appeals.map((item) => (
              <li key={item.appealId}>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void accessAppeal(item)}
                >
                  {item.action} · {item.state}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {detail || appeal ? (
        <section className="admin-panel">
          <h3>{detail ? "Rozhodnutie o hlásení" : "Rozhodnutie o odvolaní"}</h3>
          {detail ? (
            <p>{detail.details ?? "Bez doplňujúceho textu."}</p>
          ) : (
            <p>{appeal?.explanation}</p>
          )}
          <label>
            Interný auditný dôvod
            <input
              value={commandReason}
              onChange={(event) => setCommandReason(event.target.value)}
            />
          </label>
          <label>
            Kategória pravidla
            <input
              value={policyCategory}
              onChange={(event) => setPolicyCategory(event.target.value)}
            />
          </label>
          <label>
            Kód pravidla
            <input
              value={policyReasonCode}
              onChange={(event) => setPolicyReasonCode(event.target.value)}
            />
          </label>
          <label>
            Verzia pravidiel
            <input
              value={policyVersion}
              onChange={(event) => setPolicyVersion(event.target.value)}
            />
          </label>
          <label>
            Bezpečné vysvetlenie pre používateľa
            <textarea
              value={userFacingReason}
              onChange={(event) => setUserFacingReason(event.target.value)}
            />
          </label>
          {detail?.state === "OPEN" ? (
            <button
              disabled={busy}
              onClick={() => void workflow("start-review")}
            >
              Začať preverovanie
            </button>
          ) : null}
          {detail?.state === "UNDER_REVIEW" ? (
            <>
              <button disabled={busy} onClick={() => void noViolation()}>
                Bez porušenia
              </button>
              <label>
                ID dotknutého používateľa
                <input
                  value={subjectUserId}
                  onChange={(event) => setSubjectUserId(event.target.value)}
                />
              </label>
              <button disabled={busy} onClick={() => void hideContent()}>
                Skryť obsah
              </button>
            </>
          ) : null}
          {detail && ["ACTIONED", "NO_VIOLATION"].includes(detail.state) ? (
            <button disabled={busy} onClick={() => void workflow("close")}>
              Uzavrieť
            </button>
          ) : null}
          {detail?.state === "CLOSED" ? (
            <button disabled={busy} onClick={() => void workflow("reopen")}>
              Znovu otvoriť
            </button>
          ) : null}
          {appeal?.state === "OPEN" ? (
            <>
              <button
                disabled={busy}
                onClick={() => void decideAppeal("uphold")}
              >
                Potvrdiť opatrenie
              </button>
              <button
                disabled={busy}
                onClick={() => void decideAppeal("reverse")}
              >
                Zrušiť opatrenie
              </button>
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const csrfResponse = await fetch("/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const csrfBody: unknown = await csrfResponse.json();
  if (
    !csrfResponse.ok ||
    !record(csrfBody) ||
    typeof csrfBody.csrfToken !== "string"
  )
    throw new Error("csrf unavailable");
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrfBody.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

function parseReports(value: unknown): readonly ReportItem[] | null {
  if (!record(value) || !Array.isArray(value.items)) return null;
  return value.items.every(reportItem) ? (value.items as ReportItem[]) : null;
}
function parseAppeals(value: unknown): readonly AppealItem[] | null {
  if (!record(value) || !Array.isArray(value.items)) return null;
  return value.items.every(appealItem) ? (value.items as AppealItem[]) : null;
}
function parseReportDetail(value: unknown): ReportDetail | null {
  if (!record(value) || !reportItem(value.detail) || !record(value.detail))
    return null;
  return typeof value.detail.reporterUserId === "string" &&
    (value.detail.details === null || typeof value.detail.details === "string")
    ? (value.detail as unknown as ReportDetail)
    : null;
}
function parseAppealDetail(value: unknown): AppealDetail | null {
  if (!record(value) || !appealItem(value.detail) || !record(value.detail))
    return null;
  return typeof value.detail.appellantUserId === "string" &&
    typeof value.detail.explanation === "string"
    ? (value.detail as unknown as AppealDetail)
    : null;
}
function reportItem(value: unknown): boolean {
  return (
    record(value) &&
    uuid(value.reportId) &&
    uuid(value.targetId) &&
    typeof value.targetType === "string" &&
    typeof value.reason === "string" &&
    ["OPEN", "UNDER_REVIEW", "ACTIONED", "NO_VIOLATION", "CLOSED"].includes(
      String(value.state),
    ) &&
    date(value.reportedAt)
  );
}
function appealItem(value: unknown): boolean {
  return (
    record(value) &&
    uuid(value.appealId) &&
    uuid(value.actionId) &&
    uuid(value.targetId) &&
    typeof value.action === "string" &&
    typeof value.targetType === "string" &&
    ["OPEN", "UPHELD", "REDUCED", "REVERSED"].includes(String(value.state)) &&
    date(value.submittedAt)
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
