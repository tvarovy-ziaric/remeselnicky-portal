"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  observeActualVisibility,
  recordQuoteComparisonObservation,
} from "./quote-comparison";

const STATES = [
  "PENDING",
  "ENGAGED",
  "DECLINED",
  "EXPIRED",
  "WITHDRAWN",
  "NOT_SELECTED",
] as const;

type InvitationState = (typeof STATES)[number];
type Perspective = "CRAFTSMAN" | "CUSTOMER";
type Action = "DECLINE" | "ENGAGE" | "STOP_CONSIDERING" | "WITHDRAW";

export interface InvitationDetailView {
  readonly changedAt: string;
  readonly competitionDisclosure: "CUSTOMER_MAY_CONTACT_OTHERS";
  readonly counterpartDisplayName: string;
  readonly customerTrust: {
    readonly permittedReviewComments: readonly string[];
    readonly rating: number | null;
    readonly reviewCount: number;
  };
  readonly displayedRequestContentRevision: number;
  readonly displayedRequestVisibleVersion: number;
  readonly expiresAt: string;
  readonly id: string;
  readonly jobRequestId: string;
  readonly perspective: Perspective;
  readonly request: {
    readonly approximateDistanceKm: number | null;
    readonly budget: {
      readonly currency: "EUR";
      readonly maximumAmountCents: number | null;
      readonly minimumAmountCents: number | null;
      readonly mode: "RANGE" | "UNKNOWN" | "UP_TO" | null;
    };
    readonly description: string;
    readonly details: {
      readonly approximateQuantity: string | null;
      readonly customRequirements: string | null;
      readonly materialResponsibility: string | null;
      readonly siteInspection: string | null;
    };
    readonly documentMediaAssetIds: readonly string[];
    readonly municipalityCode: string;
    readonly photoMediaAssetIds: readonly string[];
    readonly primaryProfessionCode: string;
    readonly relatedProfessionCodes: readonly string[];
    readonly skillCodes: readonly string[];
    readonly specializationCode: string | null;
    readonly timing: {
      readonly completionDeadline: string | null;
      readonly endsOn: string | null;
      readonly mode: string | null;
      readonly startsOn: string | null;
    };
    readonly title: string;
  };
  readonly revision: number;
  readonly requestContentRevision: number;
  readonly requestTitle: string;
  readonly requestVisibleVersion: number;
  readonly state: InvitationState;
}

export type InvitationLoadResult =
  | {
      readonly status:
        "ACCOUNT_INACTIVE" | "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE";
    }
  | { readonly invitation: InvitationDetailView; readonly status: "OK" };

export type InvitationActionResult =
  | {
      readonly status:
        | "ACCOUNT_INACTIVE"
        | "AUTH_REQUIRED"
        | "CONFLICT"
        | "NOT_FOUND"
        | "UNAVAILABLE";
    }
  | {
      readonly revision: number;
      readonly state: InvitationState;
      readonly status: "OK";
    };

export function JobInvitationDetail({
  invitationId,
  requestContentRevision,
}: {
  readonly invitationId: string;
  readonly requestContentRevision?: number;
}) {
  const [result, setResult] = useState<InvitationLoadResult | null>(null);
  const [pending, setPending] = useState(false);
  const invitationElement = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    void loadJobInvitationDetail({
      invitationId,
      ...(requestContentRevision === undefined
        ? {}
        : { requestContentRevision }),
    }).then((loaded) => {
      if (active) setResult(loaded);
    });
    return () => {
      active = false;
    };
  }, [invitationId, requestContentRevision]);

  const observedInvitation =
    result?.status === "OK" && result.invitation.perspective === "CRAFTSMAN"
      ? result.invitation
      : null;
  const observedInvitationId = observedInvitation?.id;
  const observedJobRequestId = observedInvitation?.jobRequestId;
  useEffect(() => {
    if (
      invitationElement.current === null ||
      observedInvitationId === undefined ||
      observedJobRequestId === undefined
    )
      return;
    return observeActualVisibility(invitationElement.current, () => {
      void recordQuoteComparisonObservation({
        fetch,
        invitationId: observedInvitationId,
        jobRequestId: observedJobRequestId,
        kind: "INVITATION_VIEWED",
      });
    });
  }, [observedInvitationId, observedJobRequestId]);

  if (result === null) return <p aria-live="polite">Načítavam pozvanie…</p>;
  if (result.status !== "OK")
    return <InvitationLoadFailure status={result.status} />;
  const invitation = result.invitation;
  const actions = availableActions(invitation.perspective, invitation.state);
  const conversationHref = conversationHrefForState(
    invitation.id,
    invitation.state,
  );

  async function run(action: Action) {
    setPending(true);
    const response = await submitJobInvitationAction({
      action,
      expectedRevision: invitation.revision,
      invitationId,
      perspective: invitation.perspective,
    });
    setPending(false);
    if (response.status === "OK") {
      setResult({
        invitation: {
          ...invitation,
          revision: response.revision,
          state: response.state,
        },
        status: "OK",
      });
    } else if (response.status === "NOT_FOUND") {
      setResult({ status: "NOT_FOUND" });
    } else if (response.status === "AUTH_REQUIRED") {
      setResult({ status: "AUTH_REQUIRED" });
    } else if (response.status === "ACCOUNT_INACTIVE") {
      setResult({ status: "ACCOUNT_INACTIVE" });
    } else if (response.status === "CONFLICT") {
      setResult({ status: "UNAVAILABLE" });
    }
  }

  return (
    <article className="invitation-detail" ref={invitationElement}>
      <header>
        <p className="eyebrow">Pozvanie k zákazke</p>
        <h1>{invitation.request.title}</h1>
        <p>
          {invitation.counterpartDisplayName} · {stateLabel(invitation.state)}
        </p>
      </header>
      {invitation.displayedRequestContentRevision ===
      invitation.requestContentRevision ? null : (
        <p role="status">
          Zobrazuje sa aktualizovaná verzia dopytu č.{" "}
          {invitation.displayedRequestVisibleVersion}.
        </p>
      )}
      <section aria-labelledby="invitation-description">
        <h2 id="invitation-description">Čo zákazník potrebuje</h2>
        <p>{invitation.request.description}</p>
        <dl>
          <dt>Profesia</dt>
          <dd>{invitation.request.primaryProfessionCode}</dd>
          <dt>Obec</dt>
          <dd>{invitation.request.municipalityCode}</dd>
          <dt>Približná vzdialenosť</dt>
          <dd>
            {invitation.request.approximateDistanceKm === null
              ? "Nie je dostupná"
              : `${invitation.request.approximateDistanceKm} km`}
          </dd>
          <dt>Termín</dt>
          <dd>{timingLabel(invitation.request.timing)}</dd>
          <dt>Rozpočet</dt>
          <dd>{budgetLabel(invitation.request.budget)}</dd>
        </dl>
        {invitation.request.details.customRequirements === null ? null : (
          <p>{invitation.request.details.customRequirements}</p>
        )}
        <p className="privacy-note">
          Presná adresa a kontakty sa sprístupnia až v potvrdenom pracovnom
          kontexte.
        </p>
        <p>Zákazník môže osloviť aj ďalších remeselníkov.</p>
        <p>
          {invitation.customerTrust.rating === null
            ? "Zákazník zatiaľ nemá overené hodnotenie."
            : `Hodnotenie zákazníka: ${invitation.customerTrust.rating.toFixed(1)} z 5 (${invitation.customerTrust.reviewCount})`}
        </p>
      </section>
      {actions.length === 0 ? null : (
        <div className="invitation-actions">
          {actions.map((action) => (
            <button
              disabled={pending}
              key={action}
              onClick={() => void run(action)}
              type="button"
            >
              {actionLabel(action)}
            </button>
          ))}
        </div>
      )}
      {conversationHref === null ? null : (
        <p>
          <a href={conversationHref}>Otvoriť súkromnú konverzáciu</a>
        </p>
      )}
      {pending ? <p aria-live="polite">Ukladám rozhodnutie…</p> : null}
    </article>
  );
}

export function conversationHrefForState(
  invitationId: string,
  state: InvitationState,
): string | null {
  return state === "ENGAGED" || state === "NOT_SELECTED"
    ? `/konverzacie/pozvanka/${encodeURIComponent(invitationId)}`
    : null;
}

export async function loadJobInvitationDetail(input: {
  readonly fetch?: typeof fetch;
  readonly invitationId: string;
  readonly requestContentRevision?: number;
}): Promise<InvitationLoadResult> {
  if (
    !uuid(input.invitationId) ||
    (input.requestContentRevision !== undefined &&
      (!Number.isSafeInteger(input.requestContentRevision) ||
        input.requestContentRevision < 1))
  ) {
    return { status: "NOT_FOUND" };
  }
  const path =
    input.requestContentRevision === undefined
      ? `/v1/me/invitations/${encodeURIComponent(input.invitationId)}`
      : `/v1/me/invitations/${encodeURIComponent(input.invitationId)}/versions/${input.requestContentRevision}`;
  try {
    const response = await (input.fetch ?? fetch)(path, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 403) return { status: "ACCOUNT_INACTIVE" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const parsed = parseInvitation(await response.json());
    return parsed === null
      ? { status: "UNAVAILABLE" }
      : { invitation: parsed, status: "OK" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function submitJobInvitationAction(input: {
  readonly action: Action;
  readonly commandId?: () => string;
  readonly declineNote?: string | null;
  readonly declineReason?:
    "NO_CAPACITY" | "NOT_MY_WORK" | "OTHER" | "TIMING" | "TOO_FAR" | null;
  readonly expectedRevision: number;
  readonly fetch?: typeof fetch;
  readonly invitationId: string;
  readonly perspective: Perspective;
}): Promise<InvitationActionResult> {
  if (
    !uuid(input.invitationId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    (input.perspective === "CRAFTSMAN"
      ? !["DECLINE", "ENGAGE", "WITHDRAW"].includes(input.action)
      : !["STOP_CONSIDERING", "WITHDRAW"].includes(input.action))
  ) {
    return { status: "UNAVAILABLE" };
  }
  const commandId = input.commandId?.() ?? crypto.randomUUID();
  if (!uuid(commandId)) return { status: "UNAVAILABLE" };
  const fetcher = input.fetch ?? fetch;
  try {
    const session = await fetcher("/v1/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (session.status === 401) return { status: "AUTH_REQUIRED" };
    if (!session.ok) return { status: "UNAVAILABLE" };
    const sessionBody: unknown = await session.json();
    if (!record(sessionBody) || typeof sessionBody["csrfToken"] !== "string") {
      return { status: "UNAVAILABLE" };
    }
    const craftsmanAction =
      input.perspective === "CRAFTSMAN" &&
      ["DECLINE", "ENGAGE", "WITHDRAW"].includes(input.action);
    const endpoint = craftsmanAction ? "respond" : "close";
    const response = await fetcher(
      `/v1/me/invitations/${encodeURIComponent(input.invitationId)}/${endpoint}`,
      {
        body: JSON.stringify({
          action: input.action,
          commandId,
          ...(input.declineNote === undefined
            ? {}
            : { declineNote: input.declineNote }),
          ...(input.declineReason === undefined
            ? {}
            : { declineReason: input.declineReason }),
          expectedRevision: input.expectedRevision,
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": sessionBody["csrfToken"],
        },
        method: "POST",
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 403) return { status: "ACCOUNT_INACTIVE" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) return { status: "CONFLICT" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !Number.isSafeInteger(body["revision"]) ||
      (body["revision"] as number) < 1 ||
      !STATES.includes(body["state"] as InvitationState) ||
      !["APPLIED", "DEDUPLICATED"].includes(String(body["status"]))
    ) {
      return { status: "UNAVAILABLE" };
    }
    return {
      revision: body["revision"] as number,
      state: body["state"] as InvitationState,
      status: "OK",
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

function parseInvitation(value: unknown): InvitationDetailView | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "changedAt",
      "competitionDisclosure",
      "counterpartDisplayName",
      "customerTrust",
      "displayedRequestContentRevision",
      "displayedRequestVisibleVersion",
      "expiresAt",
      "id",
      "jobRequestId",
      "perspective",
      "request",
      "requestContentRevision",
      "requestTitle",
      "requestVisibleVersion",
      "revision",
      "state",
    ])
  )
    return null;
  const request = value["request"];
  if (
    !record(request) ||
    !exactKeys(request, [
      "approximateDistanceKm",
      "budget",
      "description",
      "details",
      "documentMediaAssetIds",
      "municipalityCode",
      "photoMediaAssetIds",
      "primaryProfessionCode",
      "relatedProfessionCodes",
      "skillCodes",
      "specializationCode",
      "timing",
      "title",
    ])
  )
    return null;
  const budget = request["budget"];
  const customerTrust = value["customerTrust"];
  const details = request["details"];
  const timing = request["timing"];
  if (
    !record(customerTrust) ||
    !exactKeys(customerTrust, [
      "permittedReviewComments",
      "rating",
      "reviewCount",
    ]) ||
    !record(budget) ||
    !exactKeys(budget, [
      "currency",
      "maximumAmountCents",
      "minimumAmountCents",
      "mode",
    ]) ||
    !record(details) ||
    !exactKeys(details, [
      "approximateQuantity",
      "customRequirements",
      "materialResponsibility",
      "siteInspection",
    ]) ||
    !record(timing) ||
    !exactKeys(timing, ["completionDeadline", "endsOn", "mode", "startsOn"]) ||
    !uuid(value["id"]) ||
    !STATES.includes(value["state"] as InvitationState) ||
    (value["perspective"] !== "CUSTOMER" &&
      value["perspective"] !== "CRAFTSMAN") ||
    value["competitionDisclosure"] !== "CUSTOMER_MAY_CONTACT_OTHERS" ||
    typeof value["counterpartDisplayName"] !== "string" ||
    typeof value["expiresAt"] !== "string" ||
    !Number.isSafeInteger(value["revision"]) ||
    !Number.isSafeInteger(value["displayedRequestContentRevision"]) ||
    (value["displayedRequestContentRevision"] as number) < 1 ||
    !Number.isSafeInteger(value["displayedRequestVisibleVersion"]) ||
    (value["displayedRequestVisibleVersion"] as number) < 1 ||
    typeof request["description"] !== "string" ||
    typeof request["municipalityCode"] !== "string" ||
    typeof request["primaryProfessionCode"] !== "string" ||
    typeof request["title"] !== "string" ||
    !stringArray(request["documentMediaAssetIds"], true) ||
    !stringArray(request["photoMediaAssetIds"], true) ||
    !stringArray(request["relatedProfessionCodes"], false) ||
    !stringArray(request["skillCodes"], false) ||
    budget["currency"] !== "EUR" ||
    (request["approximateDistanceKm"] !== null &&
      (!Number.isSafeInteger(request["approximateDistanceKm"]) ||
        (request["approximateDistanceKm"] as number) < 0)) ||
    !Array.isArray(customerTrust["permittedReviewComments"]) ||
    customerTrust["permittedReviewComments"].length > 20 ||
    !customerTrust["permittedReviewComments"].every(
      (comment) => typeof comment === "string" && comment.length <= 1_000,
    ) ||
    (customerTrust["rating"] !== null &&
      (typeof customerTrust["rating"] !== "number" ||
        customerTrust["rating"] < 0 ||
        customerTrust["rating"] > 5)) ||
    !Number.isSafeInteger(customerTrust["reviewCount"]) ||
    (customerTrust["reviewCount"] as number) < 0
  )
    return null;
  return value as unknown as InvitationDetailView;
}

function availableActions(
  perspective: Perspective,
  state: InvitationState,
): readonly Action[] {
  if (perspective === "CRAFTSMAN" && state === "PENDING")
    return ["ENGAGE", "DECLINE"];
  if (perspective === "CRAFTSMAN" && state === "ENGAGED") return ["WITHDRAW"];
  if (perspective === "CUSTOMER" && state === "PENDING") return ["WITHDRAW"];
  if (perspective === "CUSTOMER" && state === "ENGAGED")
    return ["STOP_CONSIDERING"];
  return [];
}

function stateLabel(state: InvitationState): string {
  return {
    DECLINED: "odmietnuté",
    ENGAGED: "záujem potvrdený",
    EXPIRED: "platnosť vypršala",
    NOT_SELECTED: "ďalej sa neposudzuje",
    PENDING: "čaká na rozhodnutie",
    WITHDRAWN: "stiahnuté",
  }[state];
}

function actionLabel(action: Action): string {
  return {
    DECLINE: "Odmietnuť",
    ENGAGE: "Mám záujem",
    STOP_CONSIDERING: "Ukončiť posudzovanie",
    WITHDRAW: "Stiahnuť",
  }[action];
}

function timingLabel(
  timing: InvitationDetailView["request"]["timing"],
): string {
  if (timing.mode === "AS_SOON_AS_POSSIBLE") return "Čo najskôr";
  if (timing.mode === "FLEXIBLE") return "Flexibilne";
  if (timing.startsOn !== null && timing.endsOn !== null)
    return `${timing.startsOn} – ${timing.endsOn}`;
  return "Termín neuvedený";
}

function budgetLabel(
  budget: InvitationDetailView["request"]["budget"],
): string {
  const money = (cents: number) =>
    new Intl.NumberFormat("sk-SK", {
      currency: "EUR",
      style: "currency",
    }).format(cents / 100);
  if (budget.mode === "UP_TO" && budget.maximumAmountCents !== null)
    return `Do ${money(budget.maximumAmountCents)}`;
  if (
    budget.mode === "RANGE" &&
    budget.minimumAmountCents !== null &&
    budget.maximumAmountCents !== null
  )
    return `${money(budget.minimumAmountCents)} – ${money(budget.maximumAmountCents)}`;
  return "Rozpočet neuvedený";
}

function InvitationLoadFailure({
  status,
}: {
  readonly status: Exclude<InvitationLoadResult["status"], "OK">;
}) {
  const text =
    status === "AUTH_REQUIRED"
      ? "Na zobrazenie pozvania sa prihláste."
      : status === "ACCOUNT_INACTIVE"
        ? "Účet momentálne nemôže pracovať s pozvaniami."
        : status === "NOT_FOUND"
          ? "Pozvanie nie je dostupné."
          : "Pozvanie sa teraz nepodarilo načítať.";
  return <p aria-live="polite">{text}</p>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function stringArray(value: unknown, uuids: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length <= 128 &&
        (!uuids || uuid(item)),
    )
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
