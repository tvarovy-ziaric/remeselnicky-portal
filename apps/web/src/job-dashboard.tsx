"use client";

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import { JobChangeOrders } from "./change-orders";
import { JobCompletion } from "./job-completion";
import { JobContextReview } from "./job-context-review";
import { JobDocumentation } from "./job-documentation";
import { JobDisputes } from "./job-disputes";
import { JobMainReview } from "./job-main-review";
import { JobMilestones } from "./job-milestones";
import { JobOperations } from "./job-operations";
import { JobRoster } from "./job-roster";
import { JobSupervisorEvaluations } from "./job-supervisor-evaluation";
import {
  ActionLink,
  Button,
  Card,
  NextActionCard,
  PageHeader,
  StatusBadge,
  Stepper,
  Tabs,
  Timeline,
} from "./design-system";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const privateDownload =
  /^\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/download$/iu;

type Dict = Record<string, unknown>;
type Contact = { email: string | null; phone: string | null };
export interface JobDashboardData {
  id: string;
  state:
    | "CONFIRMED"
    | "IN_PROGRESS"
    | "COMPLETION_REQUESTED"
    | "COMPLETED"
    | "CANCELLED";
  acceptedAt: string;
  role: "CUSTOMER" | "PRIMARY_PROVIDER";
  providerDisplayName: string;
  customerDisplayName: string;
  winningInvitationId: string;
  request: {
    title: string;
    description: string;
    municipalityCode: string;
    contentRevision: number;
    visibleVersion: number;
    scopeDetails: Dict;
  };
  quote: {
    quoteId: string;
    revision: number;
    authoringMode: "PLATFORM_STRUCTURED" | "EXTERNAL_PDF";
    commercialContent: Dict;
    pdfDownloadPath: string | null;
  };
  currentCommercialState: {
    base: {
      source: "BASE_QUOTE";
      quoteId: string;
      revision: number;
      authoringMode: "PLATFORM_STRUCTURED" | "EXTERNAL_PDF";
      commercialContent: Dict;
    };
    approvedChanges: readonly {
      source: "APPROVED_CHANGE_ORDER";
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
      approvedAt: string;
      terms: Dict & { title: string };
    }[];
    originalTotalCents: number | null;
    fixedDeltaCents: number | null;
    exactTotalCents: number | null;
    exactTotalUnavailableReason: string | null;
  };
  supportingDocuments: readonly {
    mediaAssetId: string;
    displayFilename: string | null;
    downloadPath: string;
  }[];
  timeline: readonly {
    eventId: string;
    eventType:
      | "JOB_CONFIRMED"
      | "CONTACT_ADDRESS_UNLOCKED"
      | "JOB_STARTED"
      | "JOB_CANCELLED"
      | "PARTICIPANT_JOINED"
      | "PARTICIPANT_LEFT"
      | "PARTICIPANT_REMOVED";
    occurredAt: string;
    actorRole: "CUSTOMER" | "PRIMARY_PROVIDER" | "PARTICIPANT" | null;
    reason: string | null;
  }[];
}
export interface JobDashboardContacts {
  jobId: string;
  locationRevision: number;
  customer: Contact;
  provider: Contact;
  workLocation: {
    municipalityCode: string;
    exactAddress: string | null;
    mapPin: { latitude: number; longitude: number } | null;
    textClarification: string | null;
  };
}
export type JobDashboardLoadResult =
  | { status: "NOT_FOUND" | "UNAVAILABLE" }
  | { status: "OK"; job: JobDashboardData; contacts: JobDashboardContacts };

const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const optionalString = (value: unknown): value is string | null =>
  value === null || string(value);
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && typeof value === "number" && value > 0;
const date = (value: unknown): value is string =>
  string(value) && value.length > 0 && !Number.isNaN(Date.parse(value));
const safeContent = (value: unknown, depth = 0): boolean => {
  if (depth > 8) return false;
  if (value === null || string(value) || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      value.length <= 100 && value.every((item) => safeContent(item, depth + 1))
    );
  return (
    record(value) &&
    Object.keys(value).length <= 100 &&
    Object.values(value).every((item) => safeContent(item, depth + 1))
  );
};
const scopeDetailKeys = new Set([
  "primaryProfessionCode",
  "relatedProfessionCodes",
  "skillCodes",
  "specializationCode",
  "timingMode",
  "startsOn",
  "endsOn",
  "completionDeadline",
  "budgetMode",
  "minimumAmountCents",
  "maximumAmountCents",
  "currency",
  "approximateQuantity",
  "customRequirements",
  "materialResponsibility",
  "siteInspection",
]);
const nullableDate = (value: unknown): boolean =>
  value === null ||
  (string(value) &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    !Number.isNaN(Date.parse(value)));
const nullableText = (value: unknown): boolean =>
  value === null || string(value);
const nullableCents = (value: unknown): boolean =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
const textArray = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 100 &&
  (value as unknown[]).every(string);

function validScopeDetails(value: unknown): value is Dict {
  if (
    !record(value) ||
    !safeContent(value) ||
    Object.keys(value).some((key) => !scopeDetailKeys.has(key))
  )
    return false;
  for (const [key, item] of Object.entries(value)) {
    if (key === "relatedProfessionCodes" || key === "skillCodes") {
      if (!textArray(item)) return false;
    } else if (key === "minimumAmountCents" || key === "maximumAmountCents") {
      if (!nullableCents(item)) return false;
    } else if (
      key === "startsOn" ||
      key === "endsOn" ||
      key === "completionDeadline"
    ) {
      if (!nullableDate(item)) return false;
    } else if (key === "currency") {
      if (item !== "EUR") return false;
    } else if (!nullableText(item)) return false;
  }
  return true;
}

export function parseJobDashboard(
  value: unknown,
  jobId: string,
): JobDashboardData | null {
  if (
    !record(value) ||
    value.id !== jobId ||
    ![
      "CONFIRMED",
      "IN_PROGRESS",
      "COMPLETION_REQUESTED",
      "COMPLETED",
      "CANCELLED",
    ].includes(value.state as string) ||
    !date(value.acceptedAt) ||
    (value.role !== "CUSTOMER" && value.role !== "PRIMARY_PROVIDER") ||
    !string(value.providerDisplayName) ||
    !string(value.customerDisplayName) ||
    !string(value.winningInvitationId) ||
    !uuid.test(value.winningInvitationId) ||
    !record(value.request) ||
    !string(value.request.title) ||
    !string(value.request.description) ||
    !string(value.request.municipalityCode) ||
    !positiveInteger(value.request.contentRevision) ||
    !positiveInteger(value.request.visibleVersion) ||
    !validScopeDetails(value.request.scopeDetails) ||
    !record(value.quote) ||
    !string(value.quote.quoteId) ||
    !uuid.test(value.quote.quoteId) ||
    !positiveInteger(value.quote.revision) ||
    (value.quote.authoringMode !== "PLATFORM_STRUCTURED" &&
      value.quote.authoringMode !== "EXTERNAL_PDF") ||
    !record(value.quote.commercialContent) ||
    !safeContent(value.quote.commercialContent) ||
    !optionalString(value.quote.pdfDownloadPath) ||
    (value.quote.pdfDownloadPath !== null &&
      !privateDownload.test(value.quote.pdfDownloadPath)) ||
    (value.quote.authoringMode === "EXTERNAL_PDF" &&
      value.quote.pdfDownloadPath === null) ||
    !validCommercialState(value.currentCommercialState, value.quote) ||
    !Array.isArray(value.supportingDocuments) ||
    !Array.isArray(value.timeline)
  )
    return null;
  if (
    !value.supportingDocuments.every(
      (item: unknown) =>
        record(item) &&
        string(item.mediaAssetId) &&
        uuid.test(item.mediaAssetId) &&
        optionalString(item.displayFilename) &&
        string(item.downloadPath) &&
        privateDownload.test(item.downloadPath) &&
        item.downloadPath.toLowerCase() ===
          `/v1/media/${item.mediaAssetId.toLowerCase()}/download`,
    )
  )
    return null;
  if (
    !value.timeline.every(
      (event: unknown) =>
        record(event) &&
        string(event.eventId) &&
        uuid.test(event.eventId) &&
        (event.eventType === "JOB_CONFIRMED" ||
          event.eventType === "CONTACT_ADDRESS_UNLOCKED" ||
          event.eventType === "JOB_STARTED" ||
          event.eventType === "JOB_CANCELLED" ||
          event.eventType === "PARTICIPANT_JOINED" ||
          event.eventType === "PARTICIPANT_LEFT" ||
          event.eventType === "PARTICIPANT_REMOVED") &&
        date(event.occurredAt) &&
        validTimelineEvent(event),
    )
  )
    return null;
  if (
    !value.timeline.some(
      (event: { eventType: string }) => event.eventType === "JOB_CONFIRMED",
    ) ||
    !value.timeline.some(
      (event: { eventType: string }) =>
        event.eventType === "CONTACT_ADDRESS_UNLOCKED",
    )
  )
    return null;
  const events = value.timeline as { eventType: string }[];
  if (
    events.filter((event) => event.eventType === "JOB_STARTED").length > 1 ||
    events.filter((event) => event.eventType === "JOB_CANCELLED").length !==
      (value.state === "CANCELLED" ? 1 : 0) ||
    (value.state === "IN_PROGRESS" &&
      !events.some((event) => event.eventType === "JOB_STARTED")) ||
    (value.state === "CONFIRMED" &&
      events.some((event) => event.eventType === "JOB_STARTED"))
  )
    return null;
  return value as unknown as JobDashboardData;
}

const commercialUnavailability = new Set([
  "BASE_NOT_FIXED",
  "BASE_AMOUNT_INVALID",
  "BASE_CURRENCY_UNSUPPORTED",
  "BASE_VAT_INVALID",
  "NON_FIXED_DELTA",
  "VAT_MISMATCH",
  "UNSAFE_AMOUNT",
  "INVALID_APPROVAL_PROVENANCE",
  "CONFLICTING_APPROVALS",
]);

function validCommercialState(value: unknown, quote: Dict): boolean {
  if (
    !record(value) ||
    Object.keys(value).length !== 6 ||
    !record(value.base) ||
    Object.keys(value.base).length !== 5 ||
    value.base.source !== "BASE_QUOTE" ||
    value.base.quoteId !== quote.quoteId ||
    value.base.revision !== quote.revision ||
    value.base.authoringMode !== quote.authoringMode ||
    !record(value.base.commercialContent) ||
    !safeContent(value.base.commercialContent) ||
    JSON.stringify(value.base.commercialContent) !==
      JSON.stringify(quote.commercialContent) ||
    !Array.isArray(value.approvedChanges) ||
    value.approvedChanges.length > 200 ||
    !value.approvedChanges.every(
      (change: unknown) =>
        record(change) &&
        Object.keys(change).length === 6 &&
        change.source === "APPROVED_CHANGE_ORDER" &&
        string(change.changeOrderId) &&
        uuid.test(change.changeOrderId) &&
        string(change.revisionId) &&
        uuid.test(change.revisionId) &&
        positiveInteger(change.revisionNumber) &&
        date(change.approvedAt) &&
        record(change.terms) &&
        Object.keys(change.terms).every((key) =>
          [
            "title",
            "reason",
            "changeDescription",
            "scopeAdded",
            "scopeRemoved",
            "scopeChanged",
            "priceImpact",
            "scheduleImpact",
            "materialResponsibility",
            "warrantyChange",
            "otherConditionChange",
            "affectedMilestoneIds",
          ].includes(key),
        ) &&
        string(change.terms.title) &&
        safeContent(change.terms),
    ) ||
    !["originalTotalCents", "fixedDeltaCents", "exactTotalCents"].every(
      (key) =>
        value[key] === null ||
        (typeof value[key] === "number" && Number.isSafeInteger(value[key])),
    ) ||
    !(
      value.exactTotalUnavailableReason === null ||
      (typeof value.exactTotalUnavailableReason === "string" &&
        commercialUnavailability.has(value.exactTotalUnavailableReason))
    ) ||
    (value.exactTotalUnavailableReason === null) !==
      (value.exactTotalCents !== null) ||
    (value.exactTotalCents !== null &&
      (typeof value.originalTotalCents !== "number" ||
        typeof value.fixedDeltaCents !== "number" ||
        typeof value.exactTotalCents !== "number" ||
        value.exactTotalCents !==
          value.originalTotalCents + value.fixedDeltaCents))
  )
    return false;
  const changes = value.approvedChanges as { revisionId: string }[];
  if (
    new Set(changes.map((change) => change.revisionId)).size !== changes.length
  )
    return false;
  return true;
}

function validTimelineEvent(event: Dict): boolean {
  if (
    event.eventType === "JOB_CONFIRMED" ||
    event.eventType === "CONTACT_ADDRESS_UNLOCKED"
  )
    return event.actorRole === null && event.reason === null;
  if (event.eventType === "JOB_STARTED")
    return event.actorRole === "PRIMARY_PROVIDER" && event.reason === null;
  if (
    event.eventType === "PARTICIPANT_JOINED" ||
    event.eventType === "PARTICIPANT_LEFT"
  )
    return event.actorRole === "PARTICIPANT" && event.reason === null;
  if (event.eventType === "PARTICIPANT_REMOVED")
    return event.actorRole === "PRIMARY_PROVIDER" && event.reason === null;
  return (
    event.eventType === "JOB_CANCELLED" &&
    (event.actorRole === "CUSTOMER" ||
      event.actorRole === "PRIMARY_PROVIDER") &&
    string(event.reason) &&
    event.reason.trim().length >= 8
  );
}

function parseContact(value: unknown): Contact | null {
  return record(value) &&
    optionalString(value.email) &&
    optionalString(value.phone)
    ? { email: value.email, phone: value.phone }
    : null;
}

export function parseJobContacts(
  value: unknown,
  job: JobDashboardData,
): JobDashboardContacts | null {
  if (
    !record(value) ||
    value.jobId !== job.id ||
    !positiveInteger(value.locationRevision) ||
    !record(value.workLocation) ||
    value.workLocation.municipalityCode !== job.request.municipalityCode ||
    !optionalString(value.workLocation.exactAddress) ||
    !optionalString(value.workLocation.textClarification)
  )
    return null;
  const customer = parseContact(value.customer);
  const provider = parseContact(value.provider);
  const pin = value.workLocation.mapPin;
  if (
    !customer ||
    !provider ||
    (pin !== null &&
      (!record(pin) ||
        typeof pin.latitude !== "number" ||
        typeof pin.longitude !== "number" ||
        !Number.isFinite(pin.latitude) ||
        !Number.isFinite(pin.longitude) ||
        pin.latitude < -90 ||
        pin.latitude > 90 ||
        pin.longitude < -180 ||
        pin.longitude > 180))
  )
    return null;
  return value as unknown as JobDashboardContacts;
}

export async function loadJobDashboard(input: {
  fetch: typeof fetch;
  jobId: string;
}): Promise<JobDashboardLoadResult> {
  if (!uuid.test(input.jobId)) return { status: "NOT_FOUND" };
  let jobResponse: Response;
  try {
    jobResponse = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}`,
      { cache: "no-store", credentials: "same-origin" },
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (jobResponse.status === 404) return { status: "NOT_FOUND" };
  if (!jobResponse.ok) return { status: "UNAVAILABLE" };
  let job: JobDashboardData | null;
  try {
    job = parseJobDashboard(await jobResponse.json(), input.jobId);
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!job) return { status: "UNAVAILABLE" };
  let contactsResponse: Response;
  try {
    contactsResponse = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/contacts`,
      { cache: "no-store", credentials: "same-origin" },
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!contactsResponse.ok) return { status: "UNAVAILABLE" };
  try {
    const contacts = parseJobContacts(await contactsResponse.json(), job);
    return contacts
      ? { status: "OK", job, contacts }
      : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

function SnapshotValue({
  fieldKey,
  path = [],
  value,
}: {
  fieldKey?: string | undefined;
  path?: readonly string[];
  value: unknown;
}) {
  if (value === null) return <span>Neuvedené</span>;
  if (typeof value === "boolean") return <span>{value ? "Áno" : "Nie"}</span>;
  if (typeof value === "string") {
    const label = snapshotStringLabel(fieldKey, path, value);
    return label === null ? null : <span>{label}</span>;
  }
  if (typeof value === "number") {
    if (fieldKey === "depositPercentageBasisPoints")
      return (
        <span>
          {new Intl.NumberFormat("sk-SK", {
            maximumFractionDigits: 2,
          }).format(value / 100)}{" "}
          %
        </span>
      );
    return <span>{value}</span>;
  }
  if (Array.isArray(value)) {
    if (fieldKey === "relatedProfessionCodes")
      return <span>Počet súvisiacich profesií: {value.length}</span>;
    if (fieldKey === "skillCodes")
      return <span>Počet požadovaných zručností: {value.length}</span>;
    if (fieldKey === "affectedMilestoneIds")
      return <span>Počet dotknutých míľnikov: {value.length}</span>;
    return (
      <ol>
        {(value as unknown[]).map((item, index) => (
          <li key={index}>
            <SnapshotValue fieldKey={fieldKey} path={path} value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (record(value)) {
    const entries = Object.entries(value).flatMap(([key, item]) => {
      const label = commercialLabel(key);
      return label === null ? [] : [{ item, key, label }];
    });
    if (entries.length === 0) return null;
    return (
      <dl>
        {entries.map(({ item, key, label }) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {isMoneyField(key) ? (
                typeof item === "number" ? (
                  new Intl.NumberFormat("sk-SK", {
                    style: "currency",
                    currency: "EUR",
                  }).format(item / 100)
                ) : (
                  <SnapshotValue
                    fieldKey={key}
                    path={[...path, key]}
                    value={item}
                  />
                )
              ) : (
                <SnapshotValue
                  fieldKey={key}
                  path={[...path, key]}
                  value={item}
                />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

function isMoneyField(key: string): boolean {
  return (
    key.endsWith("AmountCents") ||
    key.endsWith("MinimumCents") ||
    key.endsWith("MaximumCents") ||
    key === "amountCents" ||
    key === "minimumCents" ||
    key === "maximumCents"
  );
}

const commercialLabels: Readonly<Record<string, string>> = {
  affectedMilestoneIds: "Dotknuté míľniky",
  amountCents: "Zmena ceny",
  approximateQuantity: "Približný rozsah",
  basis: "Základ odhadu",
  budgetMode: "Režim rozpočtu",
  changeDescription: "Opis zmeny",
  components: "Položky ceny",
  completionDeadline: "Termín dokončenia",
  conditionalOnInspection: "Podmienené obhliadkou",
  currency: "Mena",
  customRequirements: "Osobitné požiadavky",
  deltaDays: "Posun v dňoch",
  depositAmountCents: "Záloha",
  depositMode: "Režim zálohy",
  depositNotes: "Poznámka k zálohe",
  depositPercentageBasisPoints: "Záloha",
  description: "Opis",
  endDate: "Koniec obdobia",
  endsOn: "Koniec obdobia",
  estimatedDurationDays: "Odhad trvania (dni)",
  estimatedStartOn: "Plánovaný začiatok",
  excludedScope: "Nezahrnuté práce",
  includedScope: "Zahrnuté práce",
  inspectionConditions: "Podmienky obhliadky",
  labor: "Práca",
  material: "Materiál",
  materialResponsibility: "Materiál",
  maximumAmountCents: "Rozpočet do",
  maximumCents: "Cena do",
  minimumAmountCents: "Rozpočet od",
  minimumCents: "Cena od",
  mode: "Spôsob",
  newDate: "Nový termín",
  other: "Ostatné",
  otherConditionChange: "Iná zmena podmienok",
  priceBasis: "Cenový základ",
  priceImpact: "Vplyv na cenu",
  priceMode: "Režim ceny",
  primaryProfessionCode: "Hlavná profesia",
  providerConfirmedSummaryMatchesPdf: "Zhoda súhrnu s PDF",
  providerNotes: "Poznámka poskytovateľa",
  rangeMaximumCents: "Cena do",
  rangeMinimumCents: "Cena od",
  reason: "Dôvod",
  relatedProfessionCodes: "Súvisiace profesie",
  scheduleImpact: "Vplyv na termín",
  scopeAdded: "Pridaný rozsah",
  scopeChanged: "Upravený rozsah",
  scopeRemoved: "Odstránený rozsah",
  siteInspection: "Obhliadka miesta",
  skillCodes: "Požadované zručnosti",
  specializationCode: "Špecializácia",
  startDate: "Začiatok obdobia",
  startsOn: "Začiatok od",
  summary: "Súhrn",
  timingMode: "Časový rámec",
  title: "Názov",
  totalAmountCents: "Celková cena",
  transport: "Doprava",
  transportAmountCents: "Doprava",
  transportDescription: "Podmienky dopravy",
  validUntil: "Platnosť ponuky",
  vatStatus: "DPH",
  warrantyChange: "Zmena záruky",
  warrantyInformation: "Záruka",
};

const snapshotEnums: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  budgetMode: {
    RANGE: "Rozpätie",
    UNKNOWN: "Bez určeného rozpočtu",
    UP_TO: "Najviac",
  },
  currency: { EUR: "euro" },
  depositMode: {
    FIXED_AMOUNT: "Pevná suma",
    NONE: "Bez zálohy",
    PERCENTAGE: "Percentuálna záloha",
  },
  materialResponsibility: {
    ADVICE_NEEDED: "Treba sa dohodnúť",
    COMBINATION: "Kombinácia",
    CUSTOMER: "Zákazník",
    CUSTOMER_PROVIDES: "Materiál zabezpečí zákazník",
    CRAFTSMAN_PROVIDES: "Materiál zabezpečí remeselník",
    MIXED: "Spoločne",
    PROVIDER: "Poskytovateľ",
  },
  priceMode: {
    ESTIMATE: "Odhad",
    FIXED: "Pevná cena",
    RANGE: "Cenové rozpätie",
  },
  siteInspection: {
    LIKELY: "Pravdepodobne áno",
    MAYBE: "Možno",
    UNKNOWN: "Nie je určené",
  },
  timingMode: {
    AS_SOON_AS_POSSIBLE: "Čo najskôr",
    FLEXIBLE: "Flexibilný termín",
    SPECIFIC_PERIOD: "Konkrétne obdobie",
  },
  vatStatus: {
    INCLUDED: "Vrátane DPH",
    NOT_VAT_REGISTERED: "Nie je platiteľ DPH",
    VAT_EXCLUDED: "Bez DPH",
    VAT_INCLUDED: "Vrátane DPH",
  },
  "priceImpact.mode": {
    ESTIMATE_DELTA: "Odhadovaná zmena",
    FIXED_DELTA: "Pevná zmena",
    NONE: "Bez zmeny ceny",
    RANGE_DELTA: "Rozpätie zmeny",
  },
  "scheduleImpact.mode": {
    DATE: "Nový termín",
    DAYS: "Posun v dňoch",
    NONE: "Bez zmeny termínu",
    RANGE: "Nové obdobie",
  },
};

function snapshotStringLabel(
  fieldKey: string | undefined,
  path: readonly string[],
  value: string,
): string | null {
  if (fieldKey === undefined) return value;
  if (fieldKey === "primaryProfessionCode")
    return "Profesia je uložená v prijatom zadaní";
  if (fieldKey === "specializationCode")
    return "Špecializácia je uložená v prijatom zadaní";
  const fullPath = path.join(".");
  const enumLabels = snapshotEnums[fullPath] ?? snapshotEnums[fieldKey];
  if (enumLabels !== undefined) return enumLabels[value] ?? "Neuvedené";
  return value;
}

function commercialLabel(key: string): string | null {
  return commercialLabels[key] ?? null;
}
function ContactDetails({
  title,
  contact,
}: {
  title: string;
  contact: Contact;
}) {
  return (
    <div>
      <h3>{title}</h3>
      <p>E-mail: {contact.email ?? "Neuvedený"}</p>
      <p>Telefón: {contact.phone ?? "Neuvedený"}</p>
    </div>
  );
}

const jobStatePresentation = {
  CANCELLED: { label: "Zákazka zrušená", tone: "error" },
  COMPLETED: { label: "Dokončená zákazka", tone: "success" },
  COMPLETION_REQUESTED: {
    label: "Čaká na potvrdenie dokončenia",
    tone: "warning",
  },
  CONFIRMED: { label: "Potvrdená zákazka", tone: "default" },
  IN_PROGRESS: { label: "Práce prebiehajú", tone: "trust" },
} as const;

export function JobDashboardView({
  job,
  contacts,
}: {
  job: JobDashboardData;
  contacts: JobDashboardContacts;
}) {
  const timeline = [...job.timeline].sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
      a.eventId.localeCompare(b.eventId),
  );
  const state = jobStatePresentation[job.state];

  return (
    <article className="job-dashboard">
      <div className="job-cockpit-heading">
        <span aria-hidden="true" className="job-cockpit-heading__icon">
          <img alt="" height="24" src="/icons/home.svg" width="24" />
        </span>
        <PageHeader
          eyebrow="Zákazka"
          lead={
            <>
              <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              <p>
                Potvrdená {new Date(job.acceptedAt).toLocaleString("sk-SK")} ·
                Zákazník: {job.customerDisplayName} · Hlavný poskytovateľ:{" "}
                {job.providerDisplayName}
              </p>
            </>
          }
          title={job.request.title}
        />
      </div>

      <JobLifecycleTracker job={job} />

      <Tabs
        items={[
          { href: "#prehlad", label: "Prehľad" },
          { href: "#spravy", label: "Správy" },
          { href: "#priebeh", label: "Priebeh" },
          { href: "#dokumenty", label: "Dokumenty" },
          { href: "#ucastnici", label: "Účastníci" },
          { href: "#zmeny", label: "Zmeny" },
        ]}
        label="Sekcie zákazky"
      />

      <div className="job-cockpit-section" id="prehlad">
        <div className="job-cockpit-overview-grid">
          <JobNextAction job={job} />
          <JobQuickActions job={job} />
          <JobTimelineSummary timeline={timeline} />
        </div>

        <div className="job-cockpit-details">
          <Card className="job-cockpit-card">
            <h2>Dohodnutý rozsah · iba na čítanie</h2>
            <p>{job.request.description}</p>
            <p>Obec zákazky je uložená v prijatom zadaní.</p>
            <h3>Podrobnosti prijatého zadania</h3>
            <SnapshotValue value={job.request.scopeDetails} />
            <p>
              Verzia zadania: {job.request.visibleVersion}, revízia obsahu:{" "}
              {job.request.contentRevision}
            </p>
          </Card>

          <Card className="job-cockpit-card">
            <h2>Kontakty a miesto výkonu</h2>
            <ContactDetails title="Zákazník" contact={contacts.customer} />
            <ContactDetails
              title="Hlavný poskytovateľ"
              contact={contacts.provider}
            />
            <p>
              Presná adresa:{" "}
              {contacts.workLocation.exactAddress ?? "Nie je uvedená"}
            </p>
            {contacts.workLocation.textClarification ? (
              <p>
                Spresnenie miesta: {contacts.workLocation.textClarification}
              </p>
            ) : null}
            {contacts.workLocation.mapPin ? (
              <p>
                Súradnice: {contacts.workLocation.mapPin.latitude},{" "}
                {contacts.workLocation.mapPin.longitude}
              </p>
            ) : null}
          </Card>

          <JobCompletion jobId={job.id} role={job.role} jobState={job.state} />
          {job.state === "COMPLETED" ? <JobMainReview jobId={job.id} /> : null}
          {job.state === "COMPLETED" && job.role === "CUSTOMER" ? (
            <JobContextReview jobId={job.id} />
          ) : null}
          {job.state === "COMPLETED" && job.role === "PRIMARY_PROVIDER" ? (
            <JobSupervisorEvaluations jobId={job.id} />
          ) : null}
          <JobDisputes jobId={job.id} />
        </div>
      </div>

      <div className="job-cockpit-section" id="spravy">
        <Card className="job-cockpit-card">
          <h2>Správy</h2>
          <p>
            Správy sú oddelené od systémovej histórie a nemenia prijatú ponuku.
          </p>
          <Link href={`/konverzacie/pozvanka/${job.winningInvitationId}`}>
            Otvoriť pokračujúcu konverzáciu
          </Link>
        </Card>
      </div>

      <div className="job-cockpit-section" id="priebeh">
        <JobOperations jobId={job.id} role={job.role} jobState={job.state} />
        <JobMilestones
          acceptedQuoteAvailable={job.quote.quoteId.length > 0}
          approvedChanges={job.currentCommercialState.approvedChanges}
          jobId={job.id}
          jobState={job.state}
          role={job.role}
        />
        <Card className="job-cockpit-card">
          <h2>Systémová história</h2>
          <Timeline
            items={timeline.map((event) => ({
              description:
                event.reason === null ? undefined : `Dôvod: ${event.reason}`,
              label: timelineEventLabel(event.eventType),
              time: new Date(event.occurredAt).toLocaleString("sk-SK"),
            }))}
          />
        </Card>
      </div>

      <div className="job-cockpit-section" id="dokumenty">
        <JobDocumentation
          jobId={job.id}
          winningInvitationId={job.winningInvitationId}
        />
        <Card className="job-cockpit-card">
          <h2>
            Pôvodná dohoda · prijatá ponuka · revízia {job.quote.revision}
          </h2>
          <p>
            {job.quote.authoringMode === "EXTERNAL_PDF"
              ? "Záväzné podrobnosti sú v prijatom PDF; nižšie je uložený sprievodný súhrn."
              : "Nemenný obsah prijatej štruktúrovanej ponuky."}
          </p>
          {job.quote.pdfDownloadPath ? (
            <p>
              <a href={job.quote.pdfDownloadPath}>Otvoriť prijaté PDF</a>
            </p>
          ) : null}
          <SnapshotValue value={job.quote.commercialContent} />
          <h3>Podporné dokumenty prijatej ponuky</h3>
          {job.supportingDocuments.length === 0 ? (
            <p>Žiadne podporné dokumenty.</p>
          ) : (
            <ul>
              {job.supportingDocuments.map((document, index) => (
                <li key={document.mediaAssetId}>
                  <a href={document.downloadPath}>
                    {document.displayFilename ??
                      `Podporný dokument ${index + 1}`}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="job-cockpit-section" id="ucastnici">
        <JobRoster jobId={job.id} jobState={job.state} />
        {job.role === "PRIMARY_PROVIDER" &&
        (job.state === "CONFIRMED" || job.state === "IN_PROGRESS") ? (
          <p>
            <Link href={`/remeselnici?jobId=${encodeURIComponent(job.id)}`}>
              Pozvať remeselníka na zákazku
            </Link>
          </p>
        ) : null}
      </div>

      <div className="job-cockpit-section" id="zmeny">
        <Card className="job-cockpit-card">
          <h2>Aktuálna obchodná dohoda</h2>
          <p>
            Základ: prijatá ponuka · revízia{" "}
            {job.currentCommercialState.base.revision}. Každá schválená zmena
            nižšie má vlastný presný záznam; pôvodná dohoda zostáva nezmenená.
          </p>
          {job.quote.authoringMode === "EXTERNAL_PDF" ? (
            <p>
              Cenový výpočet je prehľad zo štruktúrovaných údajov. Záväzné
              podrobnosti pôvodnej ponuky a PDF dodatkov sú v ich dokumentoch.
            </p>
          ) : null}
          {job.currentCommercialState.exactTotalCents !== null ? (
            <p>
              Pôvodná uvedená suma:{" "}
              {formatCommercialAmount(
                job.currentCommercialState.originalTotalCents!,
              )}
              . Schválené pevné zmeny:{" "}
              {formatCommercialAmount(
                job.currentCommercialState.fixedDeltaCents!,
              )}
              . Vypočítaná aktuálna suma:{" "}
              {formatCommercialAmount(
                job.currentCommercialState.exactTotalCents,
              )}
              .
            </p>
          ) : (
            <p>
              Presný aktuálny súčet nemožno bezpečne vypočítať z prijatej ponuky
              a schválených zmien. Pozrite si ich jednotlivo vrátane ceny a DPH.
            </p>
          )}
          <h3>Schválené zmeny</h3>
          {job.currentCommercialState.approvedChanges.length === 0 ? (
            <p>Zatiaľ žiadne. Platí pôvodná dohoda.</p>
          ) : (
            <ol>
              {job.currentCommercialState.approvedChanges.map((change) => (
                <li key={change.revisionId}>
                  <p>
                    <Link
                      href={`/zakazky/${job.id}/zmeny/${change.changeOrderId}/revizie/${change.revisionId}`}
                    >
                      {change.terms.title} · revízia {change.revisionNumber}
                    </Link>{" "}
                    · schválené{" "}
                    {new Date(change.approvedAt).toLocaleString("sk-SK")}
                  </p>
                  <SnapshotValue value={change.terms} />
                </li>
              ))}
            </ol>
          )}
        </Card>
        <JobChangeOrders jobId={job.id} jobState={job.state} role={job.role} />
      </div>

      {job.state === "CONFIRMED" || job.state === "IN_PROGRESS" ? (
        <Card className="job-danger-zone">
          <h2>Zrušenie zákazky</h2>
          <p>Zrušenie je vážny krok. Dôvod sa zachová v histórii zákazky.</p>
          <JobCancellationAction job={job} />
        </Card>
      ) : null}
    </article>
  );
}

function JobLifecycleTracker({ job }: { job: JobDashboardData }) {
  const started = job.timeline.find(
    (event) => event.eventType === "JOB_STARTED",
  );
  const current =
    job.state === "COMPLETED"
      ? 4
      : job.state === "COMPLETION_REQUESTED"
        ? 3
        : job.state === "IN_PROGRESS" || started !== undefined
          ? 2
          : 1;
  return (
    <Card className="job-lifecycle-card">
      <h2 className="visually-hidden">Priebeh zákazky</h2>
      <Stepper
        current={current}
        steps={["Potvrdená", "Prebieha", "Odovzdanie", "Dokončená"]}
      />
    </Card>
  );
}

function JobQuickActions({ job }: { job: JobDashboardData }) {
  return (
    <Card className="job-quick-actions">
      <h2>Rýchle akcie</h2>
      <nav aria-label="Rýchle akcie zákazky">
        <ActionLink
          className="job-quick-action"
          href={`/konverzacie/pozvanka/${job.winningInvitationId}`}
        >
          <img alt="" aria-hidden="true" src="/icons/message.svg" />
          Napísať správu
        </ActionLink>
        <ActionLink
          className="job-quick-action"
          href="#dokumenty"
          variant="secondary"
        >
          <img alt="" aria-hidden="true" src="/icons/file.svg" />
          Pridať dokumentáciu
        </ActionLink>
        <ActionLink
          className="job-quick-action"
          href="#zmeny"
          variant="secondary"
        >
          <img alt="" aria-hidden="true" src="/icons/change.svg" />
          Otvoriť zmeny
        </ActionLink>
        <ActionLink
          className="job-quick-action"
          href="#ucastnici"
          variant="secondary"
        >
          <img alt="" aria-hidden="true" src="/icons/users.svg" />
          Zobraziť účastníkov
        </ActionLink>
      </nav>
    </Card>
  );
}

function JobTimelineSummary({
  timeline,
}: {
  timeline: ReadonlyArray<JobDashboardData["timeline"][number]>;
}) {
  const latest = timeline.slice(-5);
  return (
    <Card className="job-timeline-summary">
      <header>
        <h2>Časová os</h2>
        <a href="#priebeh">Zobraziť všetko</a>
      </header>
      <Timeline
        items={latest.map((event) => ({
          description:
            event.reason === null ? undefined : `Dôvod: ${event.reason}`,
          label: timelineEventLabel(event.eventType),
          time: new Date(event.occurredAt).toLocaleString("sk-SK"),
        }))}
      />
    </Card>
  );
}

function JobNextAction({ job }: { job: JobDashboardData }) {
  if (job.state === "CONFIRMED" && job.role === "PRIMARY_PROVIDER")
    return (
      <NextActionCard
        action={<JobStartAction job={job} />}
        description="Potvrďte začatie prác. Po začatí sa stav zákazky zmení a obe strany uvidia prebiehajúcu realizáciu."
        title="Čo treba urobiť teraz"
      />
    );
  if (job.state === "CONFIRMED")
    return (
      <NextActionCard
        action={
          <ActionLink href="#spravy" variant="secondary">
            Otvoriť správy
          </ActionLink>
        }
        description="Počkajte na začatie prác. Na začatie čakáme na hlavného poskytovateľa; dohodu môžete priebežne upresniť v správach."
        title="Čo treba urobiť teraz"
      />
    );
  if (job.state === "IN_PROGRESS")
    return (
      <NextActionCard
        action={
          <ActionLink href="#priebeh" variant="secondary">
            Pozrieť priebeh
          </ActionLink>
        }
        description="Sledujte realizáciu. Práce prebiehajú; zaznamenávajte priebeh a dôležité dohody v zákazke."
        title="Čo treba urobiť teraz"
      />
    );
  if (job.state === "COMPLETION_REQUESTED" && job.role === "CUSTOMER")
    return (
      <NextActionCard
        action={
          <ActionLink href="#prehlad">Skontrolovať dokončenie</ActionLink>
        }
        description="Rozhodnite o dokončení. Poskytovateľ požiadal o potvrdenie; skontrolujte výsledok a odpovedzte v časti Prehľad."
        title="Čo treba urobiť teraz"
      />
    );
  if (job.state === "COMPLETION_REQUESTED")
    return (
      <NextActionCard
        action={
          <ActionLink href="#spravy" variant="secondary">
            Otvoriť správy
          </ActionLink>
        }
        description="Počkajte na potvrdenie zákazníka. Žiadosť o dokončenie bola odoslaná."
        title="Čo treba urobiť teraz"
      />
    );
  if (job.state === "COMPLETED")
    return (
      <NextActionCard
        action={
          <ActionLink href="#prehlad" variant="secondary">
            Skontrolovať hodnotenie
          </ActionLink>
        }
        description="Uzavrite skúsenosť so zákazkou. Dostupné možnosti hodnotenia overí server v časti Prehľad."
        title="Čo treba urobiť teraz"
      />
    );
  return (
    <NextActionCard
      action={
        <ActionLink href="#priebeh" variant="secondary">
          Zobraziť históriu
        </ActionLink>
      }
      description="Skontrolujte uzavretú zákazku. Zachovanú históriu a dôvod nájdete v časti Priebeh."
      title="Čo treba urobiť teraz"
    />
  );
}

function timelineEventLabel(
  eventType: JobDashboardData["timeline"][number]["eventType"],
): string {
  const labels = {
    CONTACT_ADDRESS_UNLOCKED:
      "Kontakty a adresa sprístupnené oprávneným stranám",
    JOB_CANCELLED: "Zákazka zrušená",
    JOB_CONFIRMED: "Zákazka potvrdená",
    JOB_STARTED: "Poskytovateľ začal práce",
    PARTICIPANT_JOINED: "Účastník prijal účasť na zákazke",
    PARTICIPANT_LEFT: "Účastník ukončil účasť na zákazke",
    PARTICIPANT_REMOVED: "Hlavný poskytovateľ ukončil účasť účastníka",
  } as const;
  return labels[eventType];
}
function formatCommercialAmount(cents: number): string {
  return `${new Intl.NumberFormat("sk-SK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)} €`;
}

function JobStartAction({ job }: { job: JobDashboardData }) {
  const command = useJobLifecycleCommand(job, "start");
  return (
    <>
      <Button
        disabled={command.pending}
        onClick={() => void command.execute()}
        type="button"
      >
        {command.pending ? "Spúšťam…" : "Začať práce"}
      </Button>
      {command.notice === "" ? null : (
        <p aria-live="polite" role="alert">
          {command.notice}
        </p>
      )}
    </>
  );
}

function JobCancellationAction({ job }: { job: JobDashboardData }) {
  const [reason, setReason] = useState("");
  const command = useJobLifecycleCommand(job, "cancel");
  return (
    <>
      <label htmlFor="job-cancel-reason">Dôvod zrušenia zákazky</label>
      <textarea
        id="job-cancel-reason"
        maxLength={1000}
        onChange={(event) => setReason(event.target.value)}
        value={reason}
      />
      <Button
        disabled={command.pending || reason.trim().length < 8}
        onClick={() => void command.execute(reason)}
        type="button"
        variant="destructive"
      >
        {command.pending ? "Ruším…" : "Zrušiť zákazku"}
      </Button>
      {command.notice === "" ? null : (
        <p aria-live="polite" role="alert">
          {command.notice}
        </p>
      )}
    </>
  );
}

function useJobLifecycleCommand(
  job: JobDashboardData,
  kind: "start" | "cancel",
) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ intent: string; commandId: string } | null>(null);

  const execute = async (reason = "") => {
    const normalizedReason = reason.trim();
    if (
      kind === "cancel" &&
      (normalizedReason.length < 8 || normalizedReason.length > 1000)
    ) {
      setNotice("Uveďte dôvod zrušenia v rozsahu 8 až 1000 znakov.");
      return;
    }
    setPending(true);
    setNotice("");
    const intent = `${kind}:${job.state}:${normalizedReason}`;
    if (retry.current?.intent !== intent)
      retry.current = { intent, commandId: crypto.randomUUID() };
    try {
      const sessionResponse = await fetch("/v1/auth/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const session: unknown = await sessionResponse.json();
      const csrfToken = record(session) ? session["csrfToken"] : null;
      if (
        !sessionResponse.ok ||
        typeof csrfToken !== "string" ||
        csrfToken.length === 0
      ) {
        setNotice("Reláciu sa nepodarilo overiť. Prihláste sa znova.");
        return;
      }
      const response = await fetch(`/v1/me/jobs/${job.id}/${kind}`, {
        body: JSON.stringify(
          kind === "start"
            ? { commandId: retry.current.commandId }
            : {
                commandId: retry.current.commandId,
                expectedState: job.state,
                reason: normalizedReason,
              },
        ),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        method: "POST",
      });
      if (response.ok) {
        window.location.reload();
        return;
      }
      setNotice(
        response.status === 409
          ? "Stav zákazky sa zmenil. Obnovte stránku a skontrolujte históriu."
          : response.status === 404
            ? "Táto akcia nie je pre vás dostupná."
            : "Akciu sa nepodarilo dokončiť. Skúste to znova.",
      );
    } catch {
      setNotice("Spojenie zlyhalo. Skúste to znova.");
    } finally {
      setPending(false);
    }
  };

  return { execute, notice, pending };
}
export function JobDashboard({ jobId }: { jobId: string }) {
  const [result, setResult] = useState<JobDashboardLoadResult | null>(null);
  useEffect(() => {
    let active = true;
    void loadJobDashboard({ fetch: globalThis.fetch, jobId }).then((loaded) => {
      if (active) setResult(loaded);
    });
    return () => {
      active = false;
    };
  }, [jobId]);
  if (result === null) return <p role="status">Načítava sa zákazka…</p>;
  if (result.status === "NOT_FOUND")
    return <p role="alert">Zákazka nie je dostupná.</p>;
  if (result.status !== "OK")
    return (
      <p role="alert">
        Údaje zákazky sa nepodarilo bezpečne načítať. Skúste to znova neskôr.
      </p>
    );
  return <JobDashboardView job={result.job} contacts={result.contacts} />;
}
