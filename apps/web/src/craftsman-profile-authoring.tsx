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
import { type JobRequestTaxonomySuggestion } from "./job-request-taxonomy-client";
import { TaxonomyAutocomplete } from "./taxonomy-autocomplete";
import {
  createTaxonomySuggestionClient,
  type TaxonomySuggestionClient,
  type TaxonomySuggestionKind,
} from "./taxonomy-suggestion-client";

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
      onAddService={(input) =>
        mutate(
          "service:" + input.serviceCode,
          (commandId) => authoring.addService({ ...input, commandId }),
          "Služba bola pridaná do profilu.",
        )
      }
      onDeactivateService={(input) =>
        mutate(
          "service-deactivate:" + input.craftsmanServiceId,
          (commandId) => authoring.deactivateService({ ...input, commandId }),
          "Služba bola z profilu odobratá.",
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
type AddServiceInput = Omit<
  Parameters<CraftsmanProfileAuthoringClient["addService"]>[0],
  "commandId"
>;
type DeactivateServiceInput = Omit<
  Parameters<CraftsmanProfileAuthoringClient["deactivateService"]>[0],
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
  onAddService,
  onAssignProfession,
  onDeactivateService,
  onSaveProfile,
  onSaveServiceArea,
  onSubmit,
  onVisibility,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
  readonly busy: boolean;
  readonly message: string | null;
  readonly onAddService: (input: AddServiceInput) => Promise<boolean>;
  readonly onAssignProfession: (
    input: AssignProfessionInput,
  ) => Promise<boolean>;
  readonly onDeactivateService: (
    input: DeactivateServiceInput,
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
      <CapabilityForm
        aggregate={aggregate}
        busy={busy}
        onAddService={onAddService}
        onAssign={onAssignProfession}
        onDeactivateService={onDeactivateService}
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

function CapabilityForm({
  aggregate,
  busy,
  onAddService,
  onAssign,
  onDeactivateService,
}: {
  readonly aggregate: CraftsmanAuthoringAggregate;
  readonly busy: boolean;
  readonly onAddService: (input: AddServiceInput) => Promise<boolean>;
  readonly onAssign: (input: {
    craftsmanProfessionId: string;
    declaredLevel: DeclaredLevel;
    professionCode: string;
    profileId: string;
  }) => Promise<boolean>;
  readonly onDeactivateService: (
    input: DeactivateServiceInput,
  ) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<JobRequestTaxonomySuggestion | null>(
    null,
  );
  const [level, setLevel] = useState<DeclaredLevel>("BEGINNER");
  const capabilityAttemptId = useRef<string | null>(null);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const suggestionTrigger = useRef<HTMLSpanElement | null>(null);
  const [suggestionConfirmation, setSuggestionConfirmation] = useState<
    string | null
  >(null);
  const linkedProfessionIds = serviceProfessionIdsForSuggestion(
    selected,
    aggregate,
  );
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null) return;
    capabilityAttemptId.current ??= crypto.randomUUID();
    const applied =
      selected.kind === "PROFESSION"
        ? await onAssign({
            craftsmanProfessionId: capabilityAttemptId.current,
            declaredLevel: level,
            professionCode: selected.code,
            profileId: aggregate.profile.id,
          })
        : linkedProfessionIds.length === 0
          ? false
          : await onAddService({
              craftsmanProfessionIds: linkedProfessionIds,
              craftsmanServiceId: capabilityAttemptId.current,
              profileId: aggregate.profile.id,
              serviceCode: selected.code,
            });
    if (applied) {
      capabilityAttemptId.current = null;
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
        <h2>Profesie a služby</h2>
        <p>
          Vyberte spravovanú profesiu alebo konkrétnu službu. Služba sa vždy
          priradí k jednej z vašich aktívnych profesií.
        </p>
        {aggregate.professions.length === 0 ? (
          <p>Zatiaľ nemáte pridanú profesiu.</p>
        ) : (
          <ul className="profile-authoring-list" aria-label="Pridané profesie">
            {aggregate.professions.map((profession) => (
              <li key={profession.id}>
                <strong>{profession.taxonomyLabel}</strong>{" "}
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
        {aggregate.services.length === 0 ? (
          <p>Zatiaľ nemáte pridanú konkrétnu službu.</p>
        ) : (
          <ul className="profile-authoring-list" aria-label="Pridané služby">
            {aggregate.services.map((service) => (
              <li key={service.id}>
                <strong>{service.taxonomyLabel}</strong>{" "}
                <StatusBadge
                  tone={service.state === "ACTIVE" ? "success" : "default"}
                >
                  {service.state === "ACTIVE" ? "Aktívna" : "Neaktívna"}
                </StatusBadge>{" "}
                {service.state === "ACTIVE" ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void onDeactivateService({
                        craftsmanServiceId: service.id,
                        profileId: aggregate.profile.id,
                      })
                    }
                    type="button"
                    variant="quiet"
                  >
                    Odobrať službu
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <TaxonomyAutocomplete
          emptyAction={
            <span ref={suggestionTrigger}>
              <Button
                className="taxonomy-suggestion-trigger"
                onClick={() => setSuggestionOpen(true)}
                type="button"
                variant="quiet"
              >
                Navrhnúť chýbajúcu profesiu alebo službu
              </Button>
            </span>
          }
          helperText="Vyhľadajte profesiu alebo službu, ktorú chcete uviesť v profile."
          id="capability-query"
          label="Profesia alebo služba"
          onChange={(value) => {
            setQuery(value);
            setSelected(null);
            capabilityAttemptId.current = null;
          }}
          onSelect={(suggestion) => {
            setSelected(suggestion);
            setQuery(suggestion.label);
          }}
          placeholder="Napríklad elektrikár alebo montáž zásuvky"
          scope="DISCOVERY"
          selectedCode={selected?.code ?? ""}
          value={query}
        />
        {selected?.kind === "PROFESSION" ? (
          <FormField
            description="Táto úroveň je označená ako údaj, ktorý uvádzate vy."
            label="Vaša deklarovaná úroveň"
          >
            <Select
              id="profession-level"
              onChange={(event) =>
                setLevel(event.target.value as DeclaredLevel)
              }
              value={level}
            >
              <option value="BEGINNER">Začiatočník</option>
              <option value="ADVANCED">Pokročilý</option>
              <option value="MASTER">Majster</option>
            </Select>
          </FormField>
        ) : null}
        {selected?.kind === "SERVICE" && linkedProfessionIds.length === 0 ? (
          <Notice title="Najprv pridajte súvisiacu profesiu" tone="warning">
            <p>
              Túto službu možno pridať až po výbere jednej z profesií, ku ktorým
              patrí.
            </p>
          </Notice>
        ) : null}
        <Button
          disabled={
            busy ||
            selected === null ||
            (selected.kind === "SERVICE" && linkedProfessionIds.length === 0)
          }
          type="submit"
        >
          {selected?.kind === "SERVICE" ? "Pridať službu" : "Pridať profesiu"}
        </Button>
      </form>
      {suggestionConfirmation === null ? null : (
        <Notice title="Návrh sme prijali" tone="success">
          <p role="status">{suggestionConfirmation}</p>
        </Notice>
      )}
      {suggestionOpen ? (
        <TaxonomySuggestionDialog
          initialName={query.trim()}
          onClose={() => {
            setSuggestionOpen(false);
            window.setTimeout(
              () => suggestionTrigger.current?.querySelector("button")?.focus(),
              0,
            );
          }}
          onConfirmed={(confirmation) => {
            setSuggestionOpen(false);
            setSuggestionConfirmation(confirmation);
          }}
          profileId={aggregate.profile.id}
        />
      ) : null}
    </Card>
  );
}

export function serviceProfessionIdsForSuggestion(
  suggestion: JobRequestTaxonomySuggestion | null,
  aggregate: CraftsmanAuthoringAggregate,
): readonly string[] {
  if (suggestion?.kind !== "SERVICE") return Object.freeze([]);
  const allowed = new Set(suggestion.professionCodes);
  return Object.freeze(
    aggregate.professions
      .filter(
        (profession) =>
          profession.state === "ACTIVE" &&
          allowed.has(profession.professionCode),
      )
      .map((profession) => profession.id)
      .sort(),
  );
}

export function TaxonomySuggestionDialog({
  client,
  initialName,
  onClose,
  onConfirmed,
  profileId,
}: {
  readonly client?: TaxonomySuggestionClient;
  readonly initialName: string;
  readonly onClose: () => void;
  readonly onConfirmed: (message: string) => void;
  readonly profileId: string;
}) {
  const suggestions = useMemo(
    () => client ?? createTaxonomySuggestionClient(),
    [client],
  );
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<TaxonomySuggestionKind | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ commandId: string; suggestionId: string } | null>(
    null,
  );
  const panel = useRef<HTMLDivElement | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    attempt.current ??= {
      commandId: crypto.randomUUID(),
      suggestionId: crypto.randomUUID(),
    };
    setSubmitting(true);
    setError(null);
    const result = await suggestions.submit({
      ...attempt.current,
      profileId,
      proposedDescription: description,
      proposedName: name,
      suggestedKind: kind === "" ? null : kind,
    });
    setSubmitting(false);
    if (result.status === "APPLIED") {
      attempt.current = null;
      onConfirmed(
        "Návrh čaká na kontrolu administrátorom. O výsledku vás budeme informovať.",
      );
      return;
    }
    if (result.status === "DUPLICATE_PENDING") {
      attempt.current = null;
      onConfirmed(
        "Rovnaký návrh už čaká na kontrolu administrátorom. Nie je potrebné ho posielať znova.",
      );
      return;
    }
    if (result.status !== "UNAVAILABLE") attempt.current = null;
    setError(taxonomySuggestionError(result.status));
  };
  return (
    <div
      aria-labelledby="taxonomy-suggestion-title"
      aria-modal="true"
      className="taxonomy-suggestion-dialog"
      onKeyDown={(event) => {
        if (taxonomySuggestionDialogKeyAction(event.key) === "CLOSE") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== "Tab" || panel.current === null) return;
        const focusable = Array.from(
          panel.current.querySelectorAll<HTMLElement>(
            "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])",
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      role="dialog"
    >
      <div className="taxonomy-suggestion-dialog__panel" ref={panel}>
        <p className="ui-eyebrow">Spravovaný katalóg</p>
        <h3 id="taxonomy-suggestion-title">Navrhnite chýbajúcu položku</h3>
        <p>
          Návrh sa nepridá do profilu automaticky. Najprv ho skontroluje
          administrátor a výsledok dostanete v oznámení.
        </p>
        <form
          className="profile-authoring-form"
          onSubmit={(event) => void submit(event)}
        >
          <TextInput
            autoFocus
            id="taxonomy-suggestion-name"
            label="Názov profesie alebo služby"
            maxLength={100}
            onChange={(value) => {
              setName(value);
              attempt.current = null;
            }}
            value={name}
          />
          <FormField
            description="Pomôže nám odlíšiť podobné názvy a správne návrh zaradiť."
            label="Krátky opis"
          >
            <Textarea
              id="taxonomy-suggestion-description"
              maxLength={1_000}
              minLength={10}
              onChange={(event) => {
                setDescription(event.target.value);
                attempt.current = null;
              }}
              required
              rows={4}
              value={description}
            />
          </FormField>
          <FormField
            description="Ak si nie ste istí, nechajte voľbu prázdnu."
            label="Typ (voliteľné)"
          >
            <Select
              id="taxonomy-suggestion-kind"
              onChange={(event) => {
                setKind(event.target.value as TaxonomySuggestionKind | "");
                attempt.current = null;
              }}
              value={kind}
            >
              <option value="">Neviem / nechám posúdiť</option>
              <option value="PROFESSION">Profesia</option>
              <option value="SERVICE">Služba</option>
            </Select>
          </FormField>
          {error === null ? null : <p role="alert">{error}</p>}
          <div className="taxonomy-suggestion-dialog__actions">
            <Button disabled={submitting} type="submit">
              {submitting ? "Odosielam návrh…" : "Odoslať návrh"}
            </Button>
            <Button
              disabled={submitting}
              onClick={onClose}
              type="button"
              variant="quiet"
            >
              Zrušiť
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function taxonomySuggestionDialogKeyAction(
  key: string,
): "CLOSE" | "NONE" {
  return key === "Escape" ? "CLOSE" : "NONE";
}

function taxonomySuggestionError(
  status: Exclude<
    Awaited<ReturnType<TaxonomySuggestionClient["submit"]>>["status"],
    "APPLIED"
  >,
): string {
  if (status === "DENIED")
    return "Prihlásenie vypršalo alebo na odoslanie návrhu nemáte oprávnenie.";
  if (status === "INVALID_REQUEST")
    return "Skontrolujte názov a doplňte aspoň krátky opis návrhu.";
  if (status === "PROFILE_UNAVAILABLE")
    return "Profil sa nenašiel alebo k nemu nemáte prístup.";
  return "Návrh sa teraz nepodarilo odoslať. Skúste to znova.";
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
  autoFocus = false,
  id,
  label,
  maxLength = 160,
  onChange,
  value,
}: {
  readonly autoFocus?: boolean;
  readonly id: string;
  readonly label: string;
  readonly maxLength?: number;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <FormField label={label}>
      <Input
        autoFocus={autoFocus}
        id={id}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </FormField>
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
