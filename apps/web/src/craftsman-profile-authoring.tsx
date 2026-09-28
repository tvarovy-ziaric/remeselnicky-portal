"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  createCraftsmanProfileAuthoringClient,
  type AuthoringMutationResult,
  type CraftsmanAuthoringAggregate,
  type CraftsmanProfileAuthoringClient,
  type CraftsmanProfileType,
  type DeclaredLevel,
  type ReadinessRequirement,
} from "./craftsman-profile-authoring-client";
import {
  loadJobRequestMunicipalitySuggestions,
  type JobRequestMunicipalitySuggestion,
} from "./job-request-municipality-client";
import {
  loadJobRequestTaxonomySuggestions,
  type JobRequestTaxonomySuggestion,
} from "./job-request-taxonomy-client";

type PageState =
  | { readonly kind: "LOADING" }
  | { readonly kind: "AUTHENTICATION_REQUIRED" }
  | { readonly kind: "ACCOUNT_NOT_ACTIVE" }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "UNAVAILABLE" }
  | {
      readonly aggregate: CraftsmanAuthoringAggregate;
      readonly kind: "READY";
    };

const readinessLabels: Readonly<Record<ReadinessRequirement, string>> = {
  ABOUT: "doplňte predstavenie svojej práce",
  ACTIVE_PROFESSION_WITH_DECLARED_LEVEL:
    "vyberte aktívnu profesiu a úroveň skúseností",
  BASE_MUNICIPALITY: "vyberte východiskovú obec",
  NORMAL_RADIUS: "nastavte bežný dojazd",
  VALID_IDENTITY: "dokončite overenie identity účtu",
};

export function CraftsmanProfileAuthoring({
  client,
}: {
  readonly client?: CraftsmanProfileAuthoringClient;
}) {
  const authoring = useMemo(
    () => client ?? createCraftsmanProfileAuthoringClient(),
    [client],
  );
  const [state, setState] = useState<PageState>({ kind: "LOADING" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempts = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    const result = await authoring.load();
    setState(
      result.status === "READY"
        ? { aggregate: result.aggregate, kind: "READY" }
        : { kind: result.status },
    );
    return result.status === "READY";
  }, [authoring]);

  useEffect(() => {
    let active = true;
    void authoring.load().then((result) => {
      if (!active) return;
      setState(
        result.status === "READY"
          ? { aggregate: result.aggregate, kind: "READY" }
          : { kind: result.status },
      );
    });
    return () => {
      active = false;
    };
  }, [authoring]);

  const mutate = useCallback(
    async (
      attemptKey: string | null,
      command: (commandId: string) => Promise<AuthoringMutationResult>,
      successMessage: string,
    ) => {
      if (busy) return false;
      const commandId =
        attemptKey === null
          ? ""
          : (attempts.current.get(attemptKey) ?? crypto.randomUUID());
      if (attemptKey !== null) attempts.current.set(attemptKey, commandId);
      setBusy(true);
      setMessage(null);
      const result = await command(commandId);
      if (attemptKey !== null && result.status !== "UNAVAILABLE")
        attempts.current.delete(attemptKey);
      if (result.status === "APPLIED") {
        setMessage(successMessage);
        const refreshed = await refresh();
        if (!refreshed)
          setMessage(
            successMessage +
              " Aktuálny stav sa nepodarilo načítať; obnovte stránku.",
          );
        setBusy(false);
        return true;
      }
      setMessage(mutationMessage(result.status));
      setBusy(false);
      return false;
    },
    [busy, refresh],
  );

  if (state.kind === "LOADING")
    return <p role="status">Načítavam profil remeselníka…</p>;
  if (state.kind === "AUTHENTICATION_REQUIRED")
    return (
      <section className="profile-authoring-state">
        <h1>Profil remeselníka</h1>
        <p>Na úpravu profilu sa najprv prihláste.</p>
        <a className="primary-link" href="/prihlasenie">
          Prihlásiť sa
        </a>
      </section>
    );
  if (state.kind === "ACCOUNT_NOT_ACTIVE")
    return (
      <section className="profile-authoring-state">
        <h1>Profil remeselníka</h1>
        <p>Profil bude dostupný po aktivácii a overení účtu.</p>
        <a href="/overenie">Pokračovať na overenie účtu</a>
      </section>
    );
  if (state.kind === "UNAVAILABLE")
    return (
      <section className="profile-authoring-state">
        <h1>Profil remeselníka</h1>
        <p role="alert">Profil teraz nie je dostupný. Skúste to znova.</p>
        <button type="button" onClick={() => void refresh()}>
          Skúsiť znova
        </button>
      </section>
    );
  if (state.kind === "NOT_FOUND")
    return (
      <CreateProfile
        busy={busy}
        message={message}
        onCreate={(input) =>
          mutate(
            null,
            () => authoring.createProfile(input),
            "Profil bol vytvorený.",
          )
        }
      />
    );

  const { aggregate } = state;
  return (
    <section className="profile-authoring" aria-labelledby="profile-title">
      <header className="profile-authoring-header">
        <div>
          <p className="eyebrow">Profil remeselníka</p>
          <h1 id="profile-title">Pripravte profil na zverejnenie</h1>
          <p>
            Profil sa verejne zobrazí až po schválení administrátorom a po vašom
            zapnutí viditeľnosti.
          </p>
        </div>
        <PublicationBadge aggregate={aggregate} />
      </header>
      {message === null ? null : <p role="status">{message}</p>}
      <ProfileDetailsForm
        aggregate={aggregate}
        busy={busy}
        key={aggregate.profile.id + ":" + aggregate.profile.revision}
        onSave={(input) =>
          mutate(
            null,
            () => authoring.replaceProfile(input),
            "Základné údaje boli uložené.",
          )
        }
      />
      <ProfessionForm
        aggregate={aggregate}
        busy={busy}
        onAssign={(input) =>
          mutate(
            "profession:" + input.professionCode + ":" + input.declaredLevel,
            (commandId) => authoring.assignProfession({ ...input, commandId }),
            "Profesia bola uložená.",
          )
        }
      />
      <ServiceAreaForm
        aggregate={aggregate}
        busy={busy}
        key={
          aggregate.profile.id +
          ":area:" +
          (aggregate.serviceArea?.revision ?? 0)
        }
        onSave={(input) =>
          mutate(
            "service-area:" + input.expectedRevision,
            (commandId) =>
              authoring.replaceServiceArea({ ...input, commandId }),
            "Oblasť pôsobenia bola uložená.",
          )
        }
      />
      <PublicationPanel
        aggregate={aggregate}
        busy={busy}
        onSubmit={() =>
          mutate(
            "publication-submit:" + (aggregate.publication?.revision ?? 0),
            (commandId) =>
              authoring.submitForReview({
                commandId,
                expectedRevision: aggregate.publication?.revision ?? 0,
                profileId: aggregate.profile.id,
              }),
            "Profil bol odoslaný na kontrolu.",
          )
        }
        onVisibility={(visibility) =>
          mutate(
            "publication-visibility:" +
              (aggregate.publication?.revision ?? 0) +
              ":" +
              visibility,
            (commandId) =>
              authoring.setVisibility({
                commandId,
                expectedRevision: aggregate.publication?.revision ?? 0,
                profileId: aggregate.profile.id,
                visibility,
              }),
            visibility === "PUBLIC"
              ? "Verejné zobrazenie profilu je zapnuté."
              : "Profil je skrytý.",
          )
        }
      />
    </section>
  );
}

type CreateInput = Parameters<
  CraftsmanProfileAuthoringClient["createProfile"]
>[0];

function CreateProfile({
  busy,
  message,
  onCreate,
}: {
  readonly busy: boolean;
  readonly message: string | null;
  readonly onCreate: (input: CreateInput) => Promise<boolean>;
}) {
  const [profileType, setProfileType] =
    useState<CraftsmanProfileType>("INDIVIDUAL");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [nickname, setNickname] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [about, setAbout] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onCreate(
      profileType === "INDIVIDUAL"
        ? {
            about,
            nickname,
            profileType,
            realFirstName: firstName,
            realLastName: lastName,
          }
        : {
            about,
            companyRegistrationNumber: registrationNumber,
            officialCompanyName: companyName,
            profileType,
          },
    );
  };
  return (
    <section
      className="profile-authoring"
      aria-labelledby="profile-create-title"
    >
      <p className="eyebrow">Profil remeselníka</p>
      <h1 id="profile-create-title">Vytvorte si profesionálny profil</h1>
      <p>
        Začnite základnými údajmi. Profil nebude verejný bez kontroly a vášho
        rozhodnutia.
      </p>
      <form className="profile-authoring-form" onSubmit={submit}>
        <label htmlFor="profile-type">Typ profilu</label>
        <select
          id="profile-type"
          onChange={(event) =>
            setProfileType(event.target.value as CraftsmanProfileType)
          }
          value={profileType}
        >
          <option value="INDIVIDUAL">Fyzická osoba</option>
          <option value="COMPANY">Firma</option>
        </select>
        {profileType === "INDIVIDUAL" ? (
          <>
            <TextInput
              id="profile-first-name"
              label="Meno"
              onChange={setFirstName}
              value={firstName}
            />
            <TextInput
              id="profile-last-name"
              label="Priezvisko"
              onChange={setLastName}
              value={lastName}
            />
            <TextInput
              id="profile-nickname"
              label="Prezývka (voliteľné)"
              onChange={setNickname}
              value={nickname}
            />
          </>
        ) : (
          <>
            <TextInput
              id="profile-company-name"
              label="Názov firmy"
              onChange={setCompanyName}
              value={companyName}
            />
            <TextInput
              id="profile-registration-number"
              label="IČO"
              onChange={setRegistrationNumber}
              value={registrationNumber}
            />
          </>
        )}
        <label htmlFor="profile-about">O vašej práci</label>
        <textarea
          id="profile-about"
          maxLength={2_000}
          onChange={(event) => setAbout(event.target.value)}
          rows={6}
          value={about}
        />
        {message === null ? null : <p role="status">{message}</p>}
        <button disabled={busy} type="submit">
          {busy ? "Vytváram profil…" : "Vytvoriť profil"}
        </button>
      </form>
    </section>
  );
}

type ReplaceInput = Parameters<
  CraftsmanProfileAuthoringClient["replaceProfile"]
>[0];

function ProfileDetailsForm({
  aggregate,
  busy,
  onSave,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
  readonly busy: boolean;
  readonly onSave: (input: ReplaceInput) => Promise<boolean>;
}) {
  const { profile } = aggregate;
  const [about, setAbout] = useState(profile.about ?? "");
  const [firstName, setFirstName] = useState(
    profile.profileType === "INDIVIDUAL" ? (profile.realFirstName ?? "") : "",
  );
  const [lastName, setLastName] = useState(
    profile.profileType === "INDIVIDUAL" ? (profile.realLastName ?? "") : "",
  );
  const [nickname, setNickname] = useState(
    profile.profileType === "INDIVIDUAL" ? (profile.nickname ?? "") : "",
  );
  const [companyName, setCompanyName] = useState(
    profile.profileType === "COMPANY"
      ? (profile.officialCompanyName ?? "")
      : "",
  );
  const [registrationNumber, setRegistrationNumber] = useState(
    profile.profileType === "COMPANY"
      ? (profile.companyRegistrationNumber ?? "")
      : "",
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const common = {
      about,
      expectedRevision: profile.revision,
      profileId: profile.id,
    };
    void onSave(
      profile.profileType === "INDIVIDUAL"
        ? {
            ...common,
            nickname,
            profileType: "INDIVIDUAL",
            realFirstName: firstName,
            realLastName: lastName,
          }
        : {
            ...common,
            companyRegistrationNumber: registrationNumber,
            officialCompanyName: companyName,
            profileType: "COMPANY",
          },
    );
  };
  return (
    <form
      className="profile-authoring-card profile-authoring-form"
      onSubmit={submit}
    >
      <h2>Základné údaje</h2>
      {profile.profileType === "INDIVIDUAL" ? (
        <>
          <TextInput
            id="details-first-name"
            label="Meno"
            onChange={setFirstName}
            value={firstName}
          />
          <TextInput
            id="details-last-name"
            label="Priezvisko"
            onChange={setLastName}
            value={lastName}
          />
          <TextInput
            id="details-nickname"
            label="Prezývka"
            onChange={setNickname}
            value={nickname}
          />
        </>
      ) : (
        <>
          <TextInput
            id="details-company-name"
            label="Názov firmy"
            onChange={setCompanyName}
            value={companyName}
          />
          <TextInput
            id="details-registration-number"
            label="IČO"
            onChange={setRegistrationNumber}
            value={registrationNumber}
          />
        </>
      )}
      <label htmlFor="details-about">O vašej práci</label>
      <textarea
        id="details-about"
        maxLength={2_000}
        onChange={(event) => setAbout(event.target.value)}
        rows={6}
        value={about}
      />
      <p className="profile-authoring-note">
        Overenie identity:{" "}
        {profile.identityVerified ? "hotové" : "čaká na dokončenie"}
      </p>
      <button disabled={busy} type="submit">
        Uložiť základné údaje
      </button>
    </form>
  );
}

function ProfessionForm({
  aggregate,
  busy,
  onAssign,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
  readonly busy: boolean;
  readonly onAssign: (input: {
    craftsmanProfessionId: string;
    declaredLevel: DeclaredLevel;
    professionCode: string;
    profileId: string;
  }) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<
    readonly JobRequestTaxonomySuggestion[]
  >([]);
  const [selected, setSelected] = useState<JobRequestTaxonomySuggestion | null>(
    null,
  );
  const [level, setLevel] = useState<DeclaredLevel>("BEGINNER");
  const professionAttemptId = useRef<string | null>(null);
  useEffect(() => {
    if (query.trim().length < 2 || selected !== null) {
      setSuggestions([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void loadJobRequestTaxonomySuggestions(query).then((items) => {
        if (active)
          setSuggestions(items.filter((item) => item.kind === "PROFESSION"));
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, selected]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null || selected.kind !== "PROFESSION") return;
    professionAttemptId.current ??= crypto.randomUUID();
    const applied = await onAssign({
      craftsmanProfessionId: professionAttemptId.current,
      declaredLevel: level,
      professionCode: selected.code,
      profileId: aggregate.profile.id,
    });
    if (applied) {
      professionAttemptId.current = null;
      setQuery("");
      setSelected(null);
    }
  };
  return (
    <form
      className="profile-authoring-card profile-authoring-form"
      onSubmit={(event) => void submit(event)}
    >
      <h2>Profesia a skúsenosti</h2>
      {aggregate.professions.length === 0 ? (
        <p>Zatiaľ nemáte pridanú profesiu.</p>
      ) : (
        <ul className="profile-authoring-list">
          {aggregate.professions.map((profession) => (
            <li key={profession.id}>
              <strong>{profession.professionCode}</strong> —{" "}
              {levelLabel(profession.declaredLevel)} (
              {profession.state === "ACTIVE" ? "aktívna" : "neaktívna"})
            </li>
          ))}
        </ul>
      )}
      <label htmlFor="profession-query">Vyhľadať profesiu</label>
      <input
        autoComplete="off"
        id="profession-query"
        maxLength={120}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(null);
          professionAttemptId.current = null;
        }}
        placeholder="Napríklad elektrikár"
        value={query}
      />
      <SuggestionList
        items={suggestions}
        label={(item) => item.label}
        onSelect={(suggestion) => {
          setSelected(suggestion);
          setQuery(suggestion.label);
          setSuggestions([]);
        }}
      />
      <label htmlFor="profession-level">Vaša deklarovaná úroveň</label>
      <select
        id="profession-level"
        onChange={(event) => setLevel(event.target.value as DeclaredLevel)}
        value={level}
      >
        <option value="BEGINNER">Začiatočník</option>
        <option value="ADVANCED">Pokročilý</option>
        <option value="MASTER">Majster</option>
      </select>
      <p className="profile-authoring-note">
        Ide o vaše vlastné vyhlásenie. Overená úroveň vzniká samostatne z
        dokladov a histórie práce.
      </p>
      <button disabled={busy || selected === null} type="submit">
        Pridať profesiu
      </button>
    </form>
  );
}

function ServiceAreaForm({
  aggregate,
  busy,
  onSave,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
  readonly busy: boolean;
  readonly onSave: (input: {
    baseMunicipalityCode: string;
    expectedRevision: number;
    normalRadiusKm: number;
    profileId: string;
  }) => Promise<boolean>;
}) {
  const [query, setQuery] = useState(
    aggregate.serviceArea?.baseMunicipalityCode ?? "",
  );
  const [selected, setSelected] =
    useState<JobRequestMunicipalitySuggestion | null>(null);
  const [suggestions, setSuggestions] = useState<
    readonly JobRequestMunicipalitySuggestion[]
  >([]);
  const [radius, setRadius] = useState(
    String(aggregate.serviceArea?.normalRadiusKm ?? 25),
  );
  useEffect(() => {
    if (query.trim().length < 2 || selected !== null) {
      setSuggestions([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void loadJobRequestMunicipalitySuggestions(query).then((items) => {
        if (active) setSuggestions(items);
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, selected]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const municipalityCode =
      selected?.code ?? aggregate.serviceArea?.baseMunicipalityCode;
    const parsedRadius = Number(radius);
    if (
      municipalityCode === null ||
      municipalityCode === undefined ||
      !Number.isFinite(parsedRadius) ||
      parsedRadius < 1 ||
      parsedRadius > 500
    )
      return;
    void onSave({
      baseMunicipalityCode: municipalityCode,
      expectedRevision: aggregate.serviceArea?.revision ?? 0,
      normalRadiusKm: parsedRadius,
      profileId: aggregate.profile.id,
    });
  };
  return (
    <form
      className="profile-authoring-card profile-authoring-form"
      onSubmit={submit}
    >
      <h2>Oblasť pôsobenia</h2>
      <label htmlFor="municipality-query">Východisková obec</label>
      <input
        autoComplete="off"
        id="municipality-query"
        maxLength={80}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(null);
        }}
        placeholder="Začnite písať obec"
        value={query}
      />
      <SuggestionList
        items={suggestions}
        label={(item) => item.name + ", okres " + item.districtName}
        onSelect={(suggestion) => {
          setSelected(suggestion);
          setQuery(suggestion.name + ", okres " + suggestion.districtName);
          setSuggestions([]);
        }}
      />
      <label htmlFor="normal-radius">Bežný dojazd v kilometroch</label>
      <input
        id="normal-radius"
        inputMode="numeric"
        max={500}
        min={1}
        onChange={(event) => setRadius(event.target.value)}
        required
        type="number"
        value={radius}
      />
      <button disabled={busy} type="submit">
        Uložiť oblasť pôsobenia
      </button>
    </form>
  );
}

function PublicationPanel({
  aggregate,
  busy,
  onSubmit,
  onVisibility,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
  readonly busy: boolean;
  readonly onSubmit: () => Promise<boolean>;
  readonly onVisibility: (visibility: "HIDDEN" | "PUBLIC") => Promise<boolean>;
}) {
  const publication = aggregate.publication;
  const missing = publication?.readiness.missing ?? deriveReadiness(aggregate);
  const canSubmit =
    missing.length === 0 &&
    (publication === null ||
      publication.reviewState === "DRAFT" ||
      publication.reviewState === "REJECTED");
  return (
    <section className="profile-authoring-card">
      <h2>Zverejnenie</h2>
      {missing.length === 0 ? (
        <p>Profil spĺňa povinné minimum na kontrolu.</p>
      ) : (
        <>
          <p>Pred odoslaním dokončite:</p>
          <ul>
            {missing.map((requirement) => (
              <li key={requirement}>{readinessLabels[requirement]}</li>
            ))}
          </ul>
        </>
      )}
      {publication?.rejection === null ||
      publication?.rejection === undefined ? null : (
        <p className="profile-authoring-warning" role="alert">
          Profil bol vrátený: {publication.rejection.userFacingReason}
        </p>
      )}
      {canSubmit ? (
        <button disabled={busy} type="button" onClick={() => void onSubmit()}>
          Odoslať profil na kontrolu
        </button>
      ) : null}
      {publication?.reviewState === "PENDING" ? (
        <p>Profil čaká na kontrolu administrátorom.</p>
      ) : null}
      {publication?.reviewState === "APPROVED" ? (
        <button
          disabled={busy}
          type="button"
          onClick={() =>
            void onVisibility(
              publication.ownerVisibility === "PUBLIC" ? "HIDDEN" : "PUBLIC",
            )
          }
        >
          {publication.ownerVisibility === "PUBLIC"
            ? "Skryť verejný profil"
            : "Zverejniť schválený profil"}
        </button>
      ) : null}
    </section>
  );
}

function PublicationBadge({
  aggregate,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
}) {
  const publication = aggregate.publication;
  const label =
    publication === null
      ? "Rozpracovaný"
      : publication.effectivelyPublic
        ? "Verejný"
        : publication.reviewState === "PENDING"
          ? "Čaká na kontrolu"
          : publication.reviewState === "APPROVED"
            ? "Schválený, skrytý"
            : publication.reviewState === "REJECTED"
              ? "Vrátený na úpravu"
              : "Rozpracovaný";
  return <span className="profile-authoring-badge">{label}</span>;
}

function TextInput({
  id,
  label,
  onChange,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        maxLength={160}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </>
  );
}

function SuggestionList<T extends { readonly code: string }>({
  items,
  label,
  onSelect,
}: {
  readonly items: readonly T[];
  readonly label: (item: T) => string;
  readonly onSelect: (item: T) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="profile-authoring-suggestions">
      {items.map((item) => (
        <li key={item.code}>
          <button type="button" onClick={() => onSelect(item)}>
            {label(item)}
          </button>
        </li>
      ))}
    </ul>
  );
}

function mutationMessage(status: AuthoringMutationResult["status"]): string {
  if (status === "DENIED")
    return "Prihlásenie vypršalo alebo na túto zmenu nemáte oprávnenie.";
  if (status === "INVALID_REQUEST") return "Skontrolujte zadané údaje.";
  if (status === "NOT_FOUND") return "Profil sa nenašiel.";
  if (status === "NOT_READY")
    return "Profil ešte nespĺňa podmienky na odoslanie.";
  if (status === "STALE_STATE")
    return "Profil sa medzitým zmenil. Obnovte stránku a skúste to znova.";
  return "Výsledok sa nepodarilo overiť. Skúste rovnakú zmenu znova.";
}

function levelLabel(level: DeclaredLevel): string {
  return level === "BEGINNER"
    ? "začiatočník"
    : level === "ADVANCED"
      ? "pokročilý"
      : "majster";
}

export function deriveReadiness(
  aggregate: CraftsmanAuthoringAggregate,
): readonly ReadinessRequirement[] {
  const missing: ReadinessRequirement[] = [];
  if (!aggregate.profile.identityVerified) missing.push("VALID_IDENTITY");
  if (!aggregate.profile.about?.trim()) missing.push("ABOUT");
  if (
    !aggregate.professions.some(
      (profession) =>
        profession.state === "ACTIVE" && profession.declaredLevel.length > 0,
    )
  )
    missing.push("ACTIVE_PROFESSION_WITH_DECLARED_LEVEL");
  if (
    aggregate.serviceArea === null ||
    aggregate.serviceArea.baseMunicipalityCode === null
  )
    missing.push("BASE_MUNICIPALITY");
  if (
    aggregate.serviceArea === null ||
    aggregate.serviceArea.normalRadiusKm === null
  )
    missing.push("NORMAL_RADIUS");
  return Object.freeze(missing);
}
