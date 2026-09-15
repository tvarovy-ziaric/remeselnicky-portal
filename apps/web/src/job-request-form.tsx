"use client";

import {
  JOB_REQUEST_CONTENT_SECTION_KEYS,
  normalizeJobRequestContentSection,
  type JobRequestContentSection,
  type JobRequestContentSectionKey,
} from "@portal/domain";
import React, { useEffect, useMemo, useState } from "react";

import {
  createJobRequestDraftClient,
  type JobRequestDraftClient,
  type JobRequestEditableDraft,
} from "./job-request-draft-client";
import {
  loadJobRequestTaxonomySuggestions,
  type JobRequestTaxonomySuggestion,
} from "./job-request-taxonomy-client";

const STEPS = Object.freeze([
  { key: "request.core", label: "Čo potrebujete" },
  { key: "request.location", label: "Miesto" },
  { key: "request.timing", label: "Termín" },
  { key: "request.budget", label: "Rozpočet" },
  { key: "request.details", label: "Podrobnosti" },
  { key: "request.media", label: "Prílohy" },
] as const);

type ViewStatus =
  | "LOADING"
  | "AUTHENTICATION_REQUIRED"
  | "READY"
  | "SAVING"
  | "ACTIVE"
  | "UNAVAILABLE";

interface EditorValues {
  approximateQuantity: string;
  budgetMaximumEuros: string;
  budgetMinimumEuros: string;
  budgetMode: "" | "UP_TO" | "RANGE" | "UNKNOWN";
  completionDeadline: string;
  customRequirements: string;
  description: string;
  endsOn: string;
  exactAddress: string;
  materialResponsibility:
    | ""
    | "CUSTOMER_PROVIDES"
    | "CRAFTSMAN_PROVIDES"
    | "ADVICE_NEEDED"
    | "COMBINATION";
  municipalityCode: string;
  primaryProfessionCode: string;
  skillCodes: readonly string[];
  siteInspection: "" | "LIKELY" | "MAYBE" | "UNKNOWN";
  specializationCode: string;
  startsOn: string;
  textClarification: string;
  timingMode: "" | "AS_SOON_AS_POSSIBLE" | "SPECIFIC_PERIOD" | "FLEXIBLE";
  title: string;
}

export function JobRequestForm({
  client: suppliedClient,
}: {
  readonly client?: JobRequestDraftClient;
}) {
  const client = useMemo(
    () => suppliedClient ?? createJobRequestDraftClient(),
    [suppliedClient],
  );
  const [status, setStatus] = useState<ViewStatus>("LOADING");
  const [csrfToken, setCsrfToken] = useState("");
  const [draft, setDraft] = useState<JobRequestEditableDraft | null>(null);
  const [values, setValues] = useState<EditorValues>(emptyValues);
  const [step, setStep] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void client.load().then((result) => {
      if (!active) return;
      if (result.status !== "READY") {
        setStatus(result.status);
        return;
      }
      setCsrfToken(result.csrfToken);
      setDraft(result.draft);
      setValues(valuesFromDraft(result.draft));
      setStatus("READY");
    });
    return () => {
      active = false;
    };
  }, [client]);

  const saveCurrent = async (): Promise<boolean> => {
    if (status !== "READY" || csrfToken === "") return false;
    let section: JobRequestContentSection;
    try {
      section = sectionFromValues(
        STEPS[step]?.key ?? "request.core",
        values,
        draft,
      );
    } catch {
      setNotice(
        "Skontrolujte označené údaje. Rozpočet musí byť celé alebo desatinné eurové číslo.",
      );
      return false;
    }
    setStatus("SAVING");
    setNotice("");
    const result = await client.save(draft, section, csrfToken);
    if (result.status === "STALE_REVISION") {
      setStatus("UNAVAILABLE");
      setNotice(
        "Dopyt sa medzitým zmenil v inom okne. Obnovte stránku, aby sa žiadna zmena neprepísala.",
      );
      return false;
    }
    if (result.status !== "SAVED") {
      setStatus("READY");
      setNotice(
        "Zmenu sa nepodarilo bezpečne uložiť. Údaje ostali vo formulári; skúste to znova.",
      );
      return false;
    }
    const nextDraft = Object.freeze({
      id: result.id,
      revision: result.revision,
      sections: replaceSection(draft?.sections ?? [], section),
    });
    setDraft(nextDraft);
    setStatus("READY");
    setNotice("Uložené");
    return true;
  };

  const continueForward = async () => {
    if (!(await saveCurrent())) return;
    if (step === STEPS.length - 1) setReviewing(true);
    else setStep((current) => current + 1);
  };

  const activate = async () => {
    if (draft === null || status !== "READY") return;
    setStatus("SAVING");
    const result = await client.activate(draft, csrfToken);
    if (result.status === "ACTIVE") {
      setStatus("ACTIVE");
      setDraft(Object.freeze({ ...draft, revision: result.revision }));
      setNotice(
        "Dopyt bol odoslaný. Teraz si môžete vybrať remeselníkov, ktorých chcete osloviť.",
      );
      return;
    }
    setStatus(result.status === "STALE_REVISION" ? "UNAVAILABLE" : "READY");
    setNotice(
      result.status === "NOT_READY"
        ? `Pred odoslaním doplňte: ${result.missingRequirements.map(requirementLabel).join(", ")}.`
        : result.status === "STALE_REVISION"
          ? "Dopyt sa zmenil v inom okne. Obnovte stránku."
          : "Dopyt sa teraz nepodarilo odoslať. Uložené údaje zostali zachované.",
    );
  };

  if (status === "LOADING")
    return (
      <FormMessage
        title="Obnovujem váš dopyt"
        text="Načítavam naposledy uloženú verziu…"
      />
    );
  if (status === "AUTHENTICATION_REQUIRED")
    return (
      <FormMessage
        title="Najprv sa prihláste"
        text="Po prihlásení sa váš rozpracovaný dopyt automaticky obnoví."
      />
    );
  if (status === "UNAVAILABLE")
    return (
      <FormMessage
        title="Dopyt sa nedá bezpečne upraviť"
        text={
          notice ||
          "Skúste stránku obnoviť. Vaše už uložené údaje zostali zachované."
        }
      />
    );
  if (status === "ACTIVE")
    return <FormMessage title="Dopyt je odoslaný" text={notice} />;

  return (
    <main className="job-request-page">
      <section
        className="job-request-shell"
        aria-labelledby="job-request-title"
      >
        <header className="job-request-header">
          <p className="eyebrow">Nový dopyt</p>
          <h1 id="job-request-title">Čo potrebujete urobiť?</h1>
          <p>
            Stačí stručný opis. Technické podrobnosti môžete doplniť neskôr.
          </p>
        </header>
        {!reviewing ? (
          <>
            <nav aria-label="Postup vytvorenia dopytu">
              <ol className="job-request-progress">
                {STEPS.map((item, index) => (
                  <li
                    aria-current={index === step ? "step" : undefined}
                    key={item.key}
                  >
                    <span>{index + 1}</span>
                    {item.label}
                  </li>
                ))}
              </ol>
            </nav>
            <div className="job-request-fields">
              {renderStep(
                STEPS[step]?.key ?? "request.core",
                values,
                setValues,
                draft,
              )}
            </div>
            <div className="job-request-actions">
              <button
                disabled={step === 0 || status === "SAVING"}
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                type="button"
              >
                Späť
              </button>
              <button
                className="primary-action"
                disabled={status === "SAVING"}
                onClick={() => void continueForward()}
                type="button"
              >
                {status === "SAVING"
                  ? "Ukladám…"
                  : step === STEPS.length - 1
                    ? "Skontrolovať dopyt"
                    : "Uložiť a pokračovať"}
              </button>
            </div>
          </>
        ) : (
          <Review
            values={values}
            draft={draft}
            onEdit={(index) => {
              setReviewing(false);
              setStep(index);
            }}
            onSubmit={() => void activate()}
            disabled={status === "SAVING"}
          />
        )}
        <p aria-live="polite" className="job-request-notice">
          {notice}
        </p>
      </section>
    </main>
  );
}

function renderStep(
  key: JobRequestContentSectionKey,
  values: EditorValues,
  setValues: React.Dispatch<React.SetStateAction<EditorValues>>,
  draft: JobRequestEditableDraft | null,
) {
  const update =
    (field: keyof EditorValues) =>
    (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) =>
      setValues((current) => ({ ...current, [field]: event.target.value }));
  switch (key) {
    case "request.core":
      return (
        <fieldset>
          <legend>Čo potrebujete</legend>
          <label>
            Stručne opíšte prácu
            <textarea
              autoFocus
              maxLength={4000}
              onChange={update("description")}
              required
              rows={6}
              value={values.description}
            />
          </label>
          <ProfessionPicker
            selectedCode={values.primaryProfessionCode}
            onSelect={(suggestion) =>
              setValues((current) => ({
                ...current,
                primaryProfessionCode:
                  suggestion.kind === "PROFESSION"
                    ? suggestion.code
                    : (suggestion.professionCodes[0] ?? ""),
                skillCodes:
                  suggestion.kind === "SKILL"
                    ? [suggestion.code]
                    : current.skillCodes,
                specializationCode:
                  suggestion.kind === "SPECIALIZATION"
                    ? suggestion.code
                    : current.specializationCode,
                title: current.title || suggestion.label,
              }))
            }
          />
          <label>
            Názov dopytu <span>(voliteľné)</span>
            <input
              maxLength={160}
              onChange={update("title")}
              value={values.title}
            />
          </label>
        </fieldset>
      );
    case "request.location":
      return (
        <fieldset>
          <legend>Kde je práca</legend>
          <label>
            Obec
            <input
              autoComplete="address-level2"
              maxLength={64}
              onChange={update("municipalityCode")}
              required
              value={values.municipalityCode}
            />
          </label>
          <label>
            Presná adresa <span>(voliteľná a súkromná)</span>
            <input
              autoComplete="street-address"
              maxLength={500}
              onChange={update("exactAddress")}
              value={values.exactAddress}
            />
          </label>
          <label>
            Spresnenie miesta <span>(voliteľné)</span>
            <textarea
              maxLength={1000}
              onChange={update("textClarification")}
              rows={3}
              value={values.textClarification}
            />
          </label>
        </fieldset>
      );
    case "request.timing":
      return (
        <fieldset>
          <legend>Kedy to potrebujete</legend>
          <label>
            Preferovaný termín
            <select onChange={update("timingMode")} value={values.timingMode}>
              <option value="">Vyberte</option>
              <option value="AS_SOON_AS_POSSIBLE">Čo najskôr</option>
              <option value="SPECIFIC_PERIOD">
                Konkrétny dátum alebo obdobie
              </option>
              <option value="FLEXIBLE">Som flexibilný/á</option>
            </select>
          </label>
          <div className="field-grid">
            <label>
              Od
              <input
                onChange={update("startsOn")}
                type="date"
                value={values.startsOn}
              />
            </label>
            <label>
              Do
              <input
                onChange={update("endsOn")}
                type="date"
                value={values.endsOn}
              />
            </label>
          </div>
          <label>
            Najneskoršie dokončenie <span>(voliteľné)</span>
            <input
              onChange={update("completionDeadline")}
              type="date"
              value={values.completionDeadline}
            />
          </label>
        </fieldset>
      );
    case "request.budget":
      return (
        <fieldset>
          <legend>Orientačný rozpočet</legend>
          <label>
            Ako chcete uviesť rozpočet
            <select onChange={update("budgetMode")} value={values.budgetMode}>
              <option value="">Neuvedené</option>
              <option value="UP_TO">Najviac do</option>
              <option value="RANGE">Rozpätie</option>
              <option value="UNKNOWN">Neviem, chcem naceniť</option>
            </select>
          </label>
          {values.budgetMode === "UP_TO" || values.budgetMode === "RANGE" ? (
            <div className="field-grid">
              {values.budgetMode === "RANGE" ? (
                <label>
                  Od (€)
                  <input
                    inputMode="decimal"
                    onChange={update("budgetMinimumEuros")}
                    value={values.budgetMinimumEuros}
                  />
                </label>
              ) : null}
              <label>
                {values.budgetMode === "RANGE" ? "Do (€)" : "Najviac (€)"}
                <input
                  inputMode="decimal"
                  onChange={update("budgetMaximumEuros")}
                  value={values.budgetMaximumEuros}
                />
              </label>
            </div>
          ) : null}
          <p className="field-help">
            Rozpočet je nepovinný a nezaväzuje vás k objednávke.
          </p>
        </fieldset>
      );
    case "request.details":
      return (
        <fieldset>
          <legend>Voliteľné podrobnosti</legend>
          <label>
            Materiál
            <select
              onChange={update("materialResponsibility")}
              value={values.materialResponsibility}
            >
              <option value="">Neuvedené</option>
              <option value="CUSTOMER_PROVIDES">Materiál mám</option>
              <option value="CRAFTSMAN_PROVIDES">
                Materiál zabezpečí remeselník
              </option>
              <option value="ADVICE_NEEDED">Potrebujem poradiť</option>
              <option value="COMBINATION">Kombinácia</option>
            </select>
          </label>
          <label>
            Obhliadka
            <select
              onChange={update("siteInspection")}
              value={values.siteInspection}
            >
              <option value="">Neuvedené</option>
              <option value="LIKELY">Pravdepodobne áno</option>
              <option value="MAYBE">Možno</option>
              <option value="UNKNOWN">Neviem</option>
            </select>
          </label>
          <label>
            Približný rozsah
            <input
              maxLength={160}
              onChange={update("approximateQuantity")}
              placeholder="napr. 20 m² alebo 2 izby"
              value={values.approximateQuantity}
            />
          </label>
          <label>
            Ďalšie požiadavky
            <textarea
              maxLength={2000}
              onChange={update("customRequirements")}
              rows={4}
              value={values.customRequirements}
            />
          </label>
        </fieldset>
      );
    case "request.media": {
      const media = sectionPayload(draft, "request.media");
      const photos = Array.isArray(media?.["photoMediaAssetIds"])
        ? media["photoMediaAssetIds"].length
        : 0;
      const documents = Array.isArray(media?.["documentMediaAssetIds"])
        ? media["documentMediaAssetIds"].length
        : 0;
      return (
        <fieldset>
          <legend>Fotky a dokumenty</legend>
          <p>
            Fotky pomôžu remeselníkovi pochopiť rozsah práce, nie sú však
            povinné.
          </p>
          <p className="attachment-summary">
            Pripojené fotky: {photos} z 10
            <br />
            Pripojené dokumenty: {documents}
          </p>
          <p className="field-help">
            Súbory zostávajú súkromné. Bezpečné nahrávanie sa sprístupní po
            uložení dopytu.
          </p>
        </fieldset>
      );
    }
  }
}

function ProfessionPicker({
  onSelect,
  selectedCode,
}: {
  readonly onSelect: (suggestion: JobRequestTaxonomySuggestion) => void;
  readonly selectedCode: string;
}) {
  const [query, setQuery] = useState(selectedCode);
  const [suggestions, setSuggestions] = useState<
    readonly JobRequestTaxonomySuggestion[]
  >([]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadJobRequestTaxonomySuggestions(
        query,
        fetch,
        controller.signal,
      ).then(setSuggestions);
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return (
    <div className="profession-picker">
      <label>
        Profesia alebo služba
        <input
          aria-describedby="profession-help"
          autoComplete="off"
          maxLength={120}
          onChange={(event) => {
            setQuery(event.target.value);
            setSuggestions([]);
          }}
          placeholder="napr. oprava strechy alebo maľovanie"
          required
          value={query}
        />
      </label>
      <p className="field-help" id="profession-help">
        Začnite písať bežnými slovami a vyberte spravovaný návrh.
      </p>
      {suggestions.length > 0 ? (
        <ul className="profession-suggestions">
          {suggestions.map((suggestion) => (
            <li key={`${suggestion.kind}:${suggestion.code}`}>
              <button
                onClick={() => {
                  onSelect(suggestion);
                  setQuery(suggestion.label);
                  setSuggestions([]);
                }}
                type="button"
              >
                {suggestion.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {selectedCode === "" ? (
        <p className="selection-state">Zatiaľ nie je vybraná žiadna služba.</p>
      ) : (
        <p className="selection-state">Vybraná služba: {query}</p>
      )}
    </div>
  );
}

function Review({
  values,
  draft,
  onEdit,
  onSubmit,
  disabled,
}: {
  readonly values: EditorValues;
  readonly draft: JobRequestEditableDraft | null;
  readonly onEdit: (index: number) => void;
  readonly onSubmit: () => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="job-request-review">
      <h2>Skontrolujte dopyt</h2>
      <ReviewRow
        label="Práca"
        value={values.description || "Chýba opis"}
        onEdit={() => onEdit(0)}
      />
      <ReviewRow
        label="Profesia"
        value={values.primaryProfessionCode || "Chýba profesia"}
        onEdit={() => onEdit(0)}
      />
      <ReviewRow
        label="Obec"
        value={values.municipalityCode || "Chýba obec"}
        onEdit={() => onEdit(1)}
      />
      <ReviewRow
        label="Termín"
        value={values.timingMode || "Neuvedený"}
        onEdit={() => onEdit(2)}
      />
      <ReviewRow
        label="Rozpočet"
        value={values.budgetMode || "Neuvedený"}
        onEdit={() => onEdit(3)}
      />
      <ReviewRow
        label="Prílohy"
        value={`${attachmentCount(draft)} pripojených`}
        onEdit={() => onEdit(5)}
      />
      <p className="privacy-note">
        Telefón, e-mail a presná adresa sa pred potvrdením zákazky remeselníkom
        verejne nezobrazujú.
      </p>
      <div className="job-request-actions">
        <button onClick={() => onEdit(0)} type="button">
          Upraviť
        </button>
        <button
          className="primary-action"
          disabled={disabled}
          onClick={onSubmit}
          type="button"
        >
          {disabled ? "Odosielam…" : "Odoslať dopyt"}
        </button>
      </div>
    </div>
  );
}

function ReviewRow({
  label,
  value,
  onEdit,
}: {
  readonly label: string;
  readonly value: string;
  readonly onEdit: () => void;
}) {
  return (
    <div className="review-row">
      <div>
        <strong>{label}</strong>
        <p>{value}</p>
      </div>
      <button onClick={onEdit} type="button">
        Upraviť
      </button>
    </div>
  );
}

function FormMessage({
  title,
  text,
}: {
  readonly title: string;
  readonly text: string;
}) {
  return (
    <main className="job-request-page">
      <section className="job-request-shell">
        <p className="eyebrow">Dopyt</p>
        <h1>{title}</h1>
        <p aria-live="polite">{text}</p>
      </section>
    </main>
  );
}

function sectionFromValues(
  key: JobRequestContentSectionKey,
  values: EditorValues,
  draft: JobRequestEditableDraft | null,
): JobRequestContentSection {
  const existing = sectionPayload(draft, key);
  const payload: unknown =
    key === "request.core"
      ? {
          description: nullIfEmpty(values.description),
          primaryProfessionCode: nullIfEmpty(values.primaryProfessionCode),
          relatedProfessionCodes: [],
          skillCodes: values.skillCodes,
          specializationCode: nullIfEmpty(values.specializationCode),
          title: nullIfEmpty(values.title),
        }
      : key === "request.location"
        ? {
            exactAddress: nullIfEmpty(values.exactAddress),
            mapPin: null,
            municipalityCode: nullIfEmpty(values.municipalityCode),
            textClarification: nullIfEmpty(values.textClarification),
          }
        : key === "request.timing"
          ? {
              completionDeadline: nullIfEmpty(values.completionDeadline),
              endsOn: nullIfEmpty(values.endsOn),
              mode: nullIfEmpty(values.timingMode),
              startsOn: nullIfEmpty(values.startsOn),
            }
          : key === "request.budget"
            ? budgetPayload(values)
            : key === "request.details"
              ? {
                  approximateQuantity: nullIfEmpty(values.approximateQuantity),
                  customRequirements: nullIfEmpty(values.customRequirements),
                  materialResponsibility: nullIfEmpty(
                    values.materialResponsibility,
                  ),
                  siteInspection: nullIfEmpty(values.siteInspection),
                }
              : {
                  documentMediaAssetIds: arrayOfStrings(
                    existing?.["documentMediaAssetIds"],
                  ),
                  photoMediaAssetIds: arrayOfStrings(
                    existing?.["photoMediaAssetIds"],
                  ),
                };
  return normalizeJobRequestContentSection({ key, payload, schemaVersion: 1 });
}

function budgetPayload(values: EditorValues) {
  const mode = nullIfEmpty(values.budgetMode);
  const minimum =
    mode === "RANGE" ? eurosToCents(values.budgetMinimumEuros) : null;
  const maximum =
    mode === "UP_TO" || mode === "RANGE"
      ? eurosToCents(values.budgetMaximumEuros)
      : null;
  return {
    currency: "EUR",
    maximumAmountCents: maximum,
    minimumAmountCents: minimum,
    mode,
  };
}

function eurosToCents(value: string): number {
  if (!/^\d{1,8}(?:[.,]\d{1,2})?$/u.test(value.trim()))
    throw new TypeError("Invalid euros");
  const amount = Number(value.replace(",", "."));
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 2_147_483_647)
    throw new TypeError("Invalid euros");
  return cents;
}

function valuesFromDraft(draft: JobRequestEditableDraft | null): EditorValues {
  const core = sectionPayload(draft, "request.core");
  const location = sectionPayload(draft, "request.location");
  const timing = sectionPayload(draft, "request.timing");
  const budget = sectionPayload(draft, "request.budget");
  const details = sectionPayload(draft, "request.details");
  return {
    ...emptyValues,
    approximateQuantity: stringValue(details?.["approximateQuantity"]),
    budgetMaximumEuros: centsToEuros(budget?.["maximumAmountCents"]),
    budgetMinimumEuros: centsToEuros(budget?.["minimumAmountCents"]),
    budgetMode: enumValue(budget?.["mode"], ["UP_TO", "RANGE", "UNKNOWN"]),
    completionDeadline: stringValue(timing?.["completionDeadline"]),
    customRequirements: stringValue(details?.["customRequirements"]),
    description: stringValue(core?.["description"]),
    endsOn: stringValue(timing?.["endsOn"]),
    exactAddress: stringValue(location?.["exactAddress"]),
    materialResponsibility: enumValue(details?.["materialResponsibility"], [
      "CUSTOMER_PROVIDES",
      "CRAFTSMAN_PROVIDES",
      "ADVICE_NEEDED",
      "COMBINATION",
    ]),
    municipalityCode: stringValue(location?.["municipalityCode"]),
    primaryProfessionCode: stringValue(core?.["primaryProfessionCode"]),
    skillCodes: arrayOfStrings(core?.["skillCodes"]),
    siteInspection: enumValue(details?.["siteInspection"], [
      "LIKELY",
      "MAYBE",
      "UNKNOWN",
    ]),
    specializationCode: stringValue(core?.["specializationCode"]),
    startsOn: stringValue(timing?.["startsOn"]),
    textClarification: stringValue(location?.["textClarification"]),
    timingMode: enumValue(timing?.["mode"], [
      "AS_SOON_AS_POSSIBLE",
      "SPECIFIC_PERIOD",
      "FLEXIBLE",
    ]),
    title: stringValue(core?.["title"]),
  };
}

function sectionPayload(
  draft: JobRequestEditableDraft | null,
  key: JobRequestContentSectionKey,
): Record<string, unknown> | undefined {
  const payload = draft?.sections.find(
    (section) => section.key === key,
  )?.payload;
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as unknown as Record<string, unknown>)
    : undefined;
}

function replaceSection(
  sections: readonly JobRequestContentSection[],
  section: JobRequestContentSection,
) {
  return Object.freeze(
    [
      ...sections.filter((candidate) => candidate.key !== section.key),
      section,
    ].sort(
      (left, right) =>
        JOB_REQUEST_CONTENT_SECTION_KEYS.indexOf(
          left.key as JobRequestContentSectionKey,
        ) -
        JOB_REQUEST_CONTENT_SECTION_KEYS.indexOf(
          right.key as JobRequestContentSectionKey,
        ),
    ),
  );
}

function attachmentCount(draft: JobRequestEditableDraft | null): number {
  const media = sectionPayload(draft, "request.media");
  return (
    arrayOfStrings(media?.["photoMediaAssetIds"]).length +
    arrayOfStrings(media?.["documentMediaAssetIds"]).length
  );
}
function arrayOfStrings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}
function nullIfEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function centsToEuros(value: unknown): string {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? (Number(value) / 100).toFixed(Number(value) % 100 === 0 ? 0 : 2)
    : "";
}
function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | "" {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : "";
}
function requirementLabel(value: string): string {
  return value === "PRIMARY_PROFESSION"
    ? "profesiu"
    : value === "DESCRIPTION"
      ? "opis práce"
      : value === "MUNICIPALITY"
        ? "obec"
        : "povinné údaje";
}

const emptyValues: EditorValues = {
  approximateQuantity: "",
  budgetMaximumEuros: "",
  budgetMinimumEuros: "",
  budgetMode: "",
  completionDeadline: "",
  customRequirements: "",
  description: "",
  endsOn: "",
  exactAddress: "",
  materialResponsibility: "",
  municipalityCode: "",
  primaryProfessionCode: "",
  skillCodes: [],
  siteInspection: "",
  specializationCode: "",
  startsOn: "",
  textClarification: "",
  timingMode: "",
  title: "",
};
