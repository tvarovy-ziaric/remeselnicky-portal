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
  ActionLink,
  Button,
  Card,
  FormField,
  Input,
  Notice,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
} from "./design-system";
import {
  createCraftsmanProfileAuthoringClient,
  type AuthoringMutationResult,
  type CraftsmanAuthoringAggregate,
  type CraftsmanProfileAuthoringClient,
  type CraftsmanProfileType,
  type DeclaredLevel,
  type ReadinessRequirement,
} from "./craftsman-profile-authoring-client";
import { type JobRequestMunicipalitySuggestion } from "./job-request-municipality-client";
import { MunicipalityAutocomplete } from "./municipality-autocomplete";
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
        <ActionLink href="/prihlasenie">Prihlásiť sa</ActionLink>
      </section>
    );
  if (state.kind === "ACCOUNT_NOT_ACTIVE")
    return (
      <section className="profile-authoring-state">
        <h1>Profil remeselníka</h1>
        <p>Profil bude dostupný po aktivácii a overení účtu.</p>
        <ActionLink href="/overenie">Pokračovať na overenie účtu</ActionLink>
      </section>
    );
  if (state.kind === "UNAVAILABLE")
    return (
      <section className="profile-authoring-state">
        <h1>Profil remeselníka</h1>
        <p role="alert">Profil teraz nie je dostupný. Skúste to znova.</p>
        <Button type="button" onClick={() => void refresh()}>
          Skúsiť znova
        </Button>
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
    <CraftsmanProfileWorkspace
      aggregate={aggregate}
      busy={busy}
      message={message}
      onAssignProfession={(input) =>
        mutate(
          "profession:" + input.professionCode + ":" + input.declaredLevel,
          (commandId) => authoring.assignProfession({ ...input, commandId }),
          "Profesia bola uložená.",
        )
      }
      onSaveProfile={(input) =>
        mutate(
          null,
          () => authoring.replaceProfile(input),
          "Základné údaje boli uložené.",
        )
      }
      onSaveServiceArea={(input) =>
        mutate(
          "service-area:" + input.expectedRevision,
          (commandId) => authoring.replaceServiceArea({ ...input, commandId }),
          "Oblasť pôsobenia bola uložená.",
        )
      }
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
  );
}

type CreateInput = Parameters<
  CraftsmanProfileAuthoringClient["createProfile"]
>[0];
type ReplaceInput = Parameters<
  CraftsmanProfileAuthoringClient["replaceProfile"]
>[0];
type AssignProfessionInput = Omit<
  Parameters<CraftsmanProfileAuthoringClient["assignProfession"]>[0],
  "commandId"
>;
type ServiceAreaInput = Omit<
  Parameters<CraftsmanProfileAuthoringClient["replaceServiceArea"]>[0],
  "commandId"
>;

export function CraftsmanProfileWorkspace({
  aggregate,
  busy,
  message,
  onAssignProfession,
  onSaveProfile,
  onSaveServiceArea,
  onSubmit,
  onVisibility,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
  readonly busy: boolean;
  readonly message: string | null;
  readonly onAssignProfession: (
    input: AssignProfessionInput,
  ) => Promise<boolean>;
  readonly onSaveProfile: (input: ReplaceInput) => Promise<boolean>;
  readonly onSaveServiceArea: (input: ServiceAreaInput) => Promise<boolean>;
  readonly onSubmit: () => Promise<boolean>;
  readonly onVisibility: (visibility: "HIDDEN" | "PUBLIC") => Promise<boolean>;
}) {
  return (
    <section className="profile-authoring" aria-label="Úprava profilu">
      <PageHeader
        actions={<PublicationBadge aggregate={aggregate} />}
        eyebrow="Profil a účet"
        lead={
          <p>
            Profil sa verejne zobrazí až po schválení administrátorom a po vašom
            zapnutí viditeľnosti. Rozpracované údaje zostávajú súkromné.
          </p>
        }
        title="Pripravte profil na zverejnenie"
      />
      {message === null ? null : (
        <Notice title="Stav úpravy" tone="trust">
          <p role="status">{message}</p>
        </Notice>
      )}
      <ProfileDetailsForm
        aggregate={aggregate}
        busy={busy}
        key={aggregate.profile.id + ":" + aggregate.profile.revision}
        onSave={onSaveProfile}
      />
      <ProfessionForm
        aggregate={aggregate}
        busy={busy}
        onAssign={onAssignProfession}
      />
      <ServiceAreaForm
        aggregate={aggregate}
        busy={busy}
        key={
          aggregate.profile.id +
          ":area:" +
          (aggregate.serviceArea?.revision ?? 0)
        }
        onSave={onSaveServiceArea}
      />
      <PublicationPanel
        aggregate={aggregate}
        busy={busy}
        onSubmit={onSubmit}
        onVisibility={onVisibility}
      />
    </section>
  );
}

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
    <section className="profile-authoring" aria-label="Vytvorenie profilu">
      <PageHeader
        eyebrow="Profil a účet"
        lead={
          <p>
            Začnite základnými údajmi. Profil zostane súkromný, kým neprejde
            kontrolou administrátora a sami nezapnete jeho viditeľnosť.
          </p>
        }
        title="Vytvorte si profil remeselníka"
      />
      <Card className="profile-authoring-card">
        <form className="profile-authoring-form" onSubmit={submit}>
          <FormField
            description="Firma zostáva v alfe profilom jedného vlastníka účtu."
            label="Typ profilu"
          >
            <Select
              id="profile-type"
              onChange={(event) =>
                setProfileType(event.target.value as CraftsmanProfileType)
              }
              value={profileType}
            >
              <option value="INDIVIDUAL">Fyzická osoba</option>
              <option value="COMPANY">Firma</option>
            </Select>
          </FormField>
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
          <FormField
            description="Stručne opíšte druh práce, ktorému sa venujete."
            label="O vašej práci"
          >
            <Textarea
              id="profile-about"
              maxLength={2_000}
              onChange={(event) => setAbout(event.target.value)}
              rows={6}
              value={about}
            />
          </FormField>
          {message === null ? null : (
            <Notice title="Stav vytvorenia" tone="trust">
              <p role="status">{message}</p>
            </Notice>
          )}
          <Button disabled={busy} type="submit">
            {busy ? "Vytváram profil…" : "Vytvoriť profil"}
          </Button>
        </form>
      </Card>
    </section>
  );
}

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
    <Card className="profile-authoring-card">
      <form className="profile-authoring-form" onSubmit={submit}>
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
        <FormField
          description="Toto predstavenie je povinnou súčasťou profilu pred kontrolou."
          label="O vašej práci"
        >
          <Textarea
            id="details-about"
            maxLength={2_000}
            onChange={(event) => setAbout(event.target.value)}
            rows={6}
            value={about}
          />
        </FormField>
        <div className="profile-authoring-note">
          <StatusBadge tone={profile.identityVerified ? "success" : "warning"}>
            {profile.identityVerified
              ? "Identita overená"
              : "Overenie identity nie je dokončené"}
          </StatusBadge>
        </div>
        <Button disabled={busy} type="submit">
          Uložiť základné údaje
        </Button>
      </form>
    </Card>
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
    <Card className="profile-authoring-card">
      <form
        className="profile-authoring-form"
        onSubmit={(event) => void submit(event)}
      >
        <h2>Profesie a úroveň</h2>
        <p>
          Vami zvolená úroveň je vlastné vyhlásenie. Podpora dôkazmi sa
          zobrazuje oddelene a vzniká iba z dokladov alebo histórie práce.
        </p>
        {aggregate.professions.length === 0 ? (
          <p>Zatiaľ nemáte pridanú profesiu.</p>
        ) : (
          <ul className="profile-authoring-list" aria-label="Pridané profesie">
            {aggregate.professions.map((profession, index) => (
              <li key={profession.id}>
                <strong>Profesia {index + 1}</strong>{" "}
                <StatusBadge
                  tone={profession.state === "ACTIVE" ? "success" : "default"}
                >
                  {profession.state === "ACTIVE" ? "Aktívna" : "Neaktívna"}
                </StatusBadge>{" "}
                <StatusBadge>
                  ○ {levelLabel(profession.declaredLevel)} · uvádza remeselník
                </StatusBadge>{" "}
                {profession.evidenceSupportedLevel === null ? null : (
                  <StatusBadge tone="trust">
                    ◐ {levelLabel(profession.evidenceSupportedLevel)} ·
                    podporené dôkazmi
                  </StatusBadge>
                )}
              </li>
            ))}
          </ul>
        )}
        <FormField
          description="Vyberte profesiu zo zoznamu návrhov."
          label="Vyhľadať profesiu"
        >
          <Input
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
        </FormField>
        <SuggestionList
          items={suggestions}
          label={(item) => item.label}
          onSelect={(suggestion) => {
            setSelected(suggestion);
            setQuery(suggestion.label);
            setSuggestions([]);
          }}
        />
        <FormField
          description="Táto úroveň je označená ako údaj, ktorý uvádzate vy."
          label="Vaša deklarovaná úroveň"
        >
          <Select
            id="profession-level"
            onChange={(event) => setLevel(event.target.value as DeclaredLevel)}
            value={level}
          >
            <option value="BEGINNER">Začiatočník</option>
            <option value="ADVANCED">Pokročilý</option>
            <option value="MASTER">Majster</option>
          </Select>
        </FormField>
        <Button disabled={busy || selected === null} type="submit">
          Pridať profesiu
        </Button>
      </form>
    </Card>
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
  const [query, setQuery] = useState("");
  const [selected, setSelected] =
    useState<JobRequestMunicipalitySuggestion | null>(null);
  const [radius, setRadius] = useState(
    String(aggregate.serviceArea?.normalRadiusKm ?? 25),
  );
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
    <Card className="profile-authoring-card">
      <form className="profile-authoring-form" onSubmit={submit}>
        <h2>Oblasť pôsobenia</h2>
        <p>
          Verejný profil používa obec a bežný dojazd. Presnú domácu adresu tu
          nezadávate ani nezverejňujeme.
        </p>
        {aggregate.serviceArea?.baseMunicipalityCode ? (
          <StatusBadge tone="success">Východisková obec je uložená</StatusBadge>
        ) : null}
        <MunicipalityAutocomplete
          id="municipality-query"
          onChange={(value) => {
            setQuery(value);
            setSelected(null);
          }}
          onSelect={(suggestion) => {
            setSelected(suggestion);
            setQuery(suggestion.name);
          }}
          selectedCode={
            selected?.code ??
            (query === ""
              ? (aggregate.serviceArea?.baseMunicipalityCode ?? "")
              : "")
          }
          selectedLabel={selected?.name}
          value={query}
        />
        <FormField
          description="Jednoduchý pracovný okruh, nie prísľub dostupnosti."
          label="Bežný dojazd v kilometroch"
        >
          <Input
            id="normal-radius"
            inputMode="numeric"
            max={500}
            min={1}
            onChange={(event) => setRadius(event.target.value)}
            required
            type="number"
            value={radius}
          />
        </FormField>
        <Button disabled={busy} type="submit">
          Uložiť oblasť pôsobenia
        </Button>
      </form>
    </Card>
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
  const moderationAllowsVisibility =
    publication === null || publication.moderationState === "ALLOWED";
  const canSubmit =
    missing.length === 0 &&
    moderationAllowsVisibility &&
    (publication === null ||
      publication.reviewState === "DRAFT" ||
      publication.reviewState === "REJECTED");
  return (
    <Card className="profile-authoring-card">
      <p className="ui-eyebrow">Súkromný kontrolný zoznam</p>
      <h2>Pripravenosť na kontrolu</h2>
      {missing.length === 0 ? (
        <Notice tone="success" title="Povinné minimum je vyplnené">
          <p>
            Profil môžete odoslať administrátorovi. Odoslanie ho samo
            nezverejní.
          </p>
        </Notice>
      ) : (
        <>
          <p>Pred odoslaním na kontrolu dokončite:</p>
          <ul>
            {missing.map((requirement) => (
              <li key={requirement}>{readinessLabels[requirement]}</li>
            ))}
          </ul>
        </>
      )}
      {publication?.rejection === null ||
      publication?.rejection === undefined ? null : (
        <Notice title="Profil bol vrátený na úpravu" tone="warning">
          <p role="alert">{publication.rejection.userFacingReason}</p>
        </Notice>
      )}
      {canSubmit ? (
        <Button disabled={busy} type="button" onClick={() => void onSubmit()}>
          Odoslať profil na kontrolu
        </Button>
      ) : null}
      {publication?.reviewState === "PENDING" ? (
        <Notice title="Kontrola prebieha" tone="trust">
          <p>
            Profil čaká na rozhodnutie administrátora. Dovtedy nie je verejný.
          </p>
        </Notice>
      ) : null}
      {publication !== null && !moderationAllowsVisibility ? (
        <Notice title="Viditeľnosť obmedzil administrátor" tone="warning">
          <p>
            Toto obmedzenie nemožno zmeniť prepínačom profilu. Údaje a história
            zostávajú zachované.
          </p>
        </Notice>
      ) : null}
      {publication?.reviewState === "APPROVED" && moderationAllowsVisibility ? (
        <Button
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
        </Button>
      ) : null}
    </Card>
  );
}

function PublicationBadge({
  aggregate,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
}) {
  const publication = aggregate.publication;
  if (publication === null)
    return <StatusBadge>Rozpracovaný súkromný profil</StatusBadge>;
  if (publication.moderationState !== "ALLOWED")
    return <StatusBadge tone="warning">Skrytý administrátorom</StatusBadge>;
  if (publication.effectivelyPublic)
    return <StatusBadge tone="success">Verejný profil</StatusBadge>;
  if (publication.reviewState === "PENDING")
    return <StatusBadge tone="trust">Čaká na kontrolu</StatusBadge>;
  if (publication.reviewState === "APPROVED")
    return <StatusBadge tone="success">Schválený, zatiaľ skrytý</StatusBadge>;
  if (publication.reviewState === "REJECTED")
    return <StatusBadge tone="warning">Vrátený na úpravu</StatusBadge>;
  return <StatusBadge>Rozpracovaný súkromný profil</StatusBadge>;
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
    <FormField label={label}>
      <Input
        id={id}
        maxLength={160}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </FormField>
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
          <Button type="button" variant="quiet" onClick={() => onSelect(item)}>
            {label(item)}
          </Button>
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
