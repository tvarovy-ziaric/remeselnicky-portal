"use client";

import React, {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ActionLink,
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  Notice,
  PageHeader,
  SectionHeader,
  Select,
  Textarea,
  TrustBadge,
} from "./design-system";

import {
  createCraftsmanPortfolioClient,
  type CraftsmanPortfolioClient,
  type OwnedPortfolioPhotoSet,
  type OwnedPortfolioProject,
  type PortfolioMutationResult,
  type PortfolioPhotoPhase,
  type PortfolioPhotoUpload,
} from "./craftsman-portfolio-client";
import {
  createCraftsmanProfileAuthoringClient,
  type CraftsmanAuthoringAggregate,
} from "./craftsman-profile-authoring-client";

const defaultClient = createCraftsmanPortfolioClient();
const defaultProfileClient = createCraftsmanProfileAuthoringClient();

export function CraftsmanPortfolio({
  client = defaultClient,
}: {
  readonly client?: CraftsmanPortfolioClient;
}) {
  const [aggregate, setAggregate] =
    useState<CraftsmanAuthoringAggregate | null>(null);
  const [projects, setProjects] = useState<readonly OwnedPortfolioProject[]>(
    [],
  );
  const [state, setState] = useState<
    "AUTH" | "EMPTY_PROFILE" | "ERROR" | "LOADING" | "READY"
  >("LOADING");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("LOADING");
    const profile = await defaultProfileClient.load();
    if (profile.status === "AUTHENTICATION_REQUIRED") {
      setState("AUTH");
      return;
    }
    if (profile.status === "NOT_FOUND") {
      setState("EMPTY_PROFILE");
      return;
    }
    if (profile.status !== "READY") {
      setState("ERROR");
      return;
    }
    const result = await client.listProjects(profile.aggregate.profile.id);
    if (result.status !== "READY") {
      setState(result.status === "AUTHENTICATION_REQUIRED" ? "AUTH" : "ERROR");
      return;
    }
    setAggregate(profile.aggregate);
    setProjects(result.value);
    setState("READY");
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "LOADING")
    return <p role="status">Načítavam vaše portfólio…</p>;
  if (state === "AUTH") {
    return (
      <EmptyState
        action={<ActionLink href="/prihlasenie">Prihlásiť sa</ActionLink>}
        description="Portfólio je súkromná časť účtu remeselníka."
        title="Najprv sa prihláste"
      />
    );
  }
  if (state === "EMPTY_PROFILE") {
    return (
      <EmptyState
        action={
          <ActionLink href="/ucet/profil-remeselnika">
            Vytvoriť profil
          </ActionLink>
        }
        description="Realizácie sa ukladajú k vášmu profilu remeselníka."
        title="Najprv vytvorte profil remeselníka"
      />
    );
  }
  if (state === "ERROR" || aggregate === null) {
    return (
      <EmptyState
        action={
          <Button onClick={() => void load()} type="button">
            Skúsiť znova
          </Button>
        }
        description="Vaše uložené realizácie sme teraz nevedeli bezpečne načítať."
        title="Portfólio sa nepodarilo načítať"
      />
    );
  }

  const professions = aggregate.professions.filter(
    (profession) => profession.state === "ACTIVE",
  );
  return (
    <section className="profile-authoring">
      <PageHeader
        actions={
          <ActionLink href="/ucet/profil-remeselnika" variant="secondary">
            Späť na profil
          </ActionLink>
        }
        eyebrow="Portfólio remeselníka"
        lead={
          <p>
            Ukážte konkrétnu prácu, svoj prínos a bezpečne spracované
            fotografie.
          </p>
        }
        title="Vaše realizácie"
      />
      <PortfolioProvenanceNotice />
      {message === null ? null : <p role="status">{message}</p>}
      <CreateProjectForm
        client={client}
        onCreated={(project) => {
          setProjects((current) => [...current, project]);
          setMessage("Súkromný projekt bol vytvorený.");
        }}
        profileId={aggregate.profile.id}
        professions={professions}
      />
      <SectionHeader
        eyebrow={`${projects.length} ${projects.length === 1 ? "realizácia" : "realizácií"}`}
        title="Uložené projekty"
      />
      {projects.length === 0 ? (
        <EmptyState
          description="Začnite projektom, ktorý najlepšie ukazuje vašu prácu a konkrétny prínos."
          title="Zatiaľ nemáte uloženú realizáciu"
        />
      ) : (
        projects.map((project) => (
          <ProjectCard
            client={client}
            key={project.id}
            onChanged={(changed) =>
              setProjects((current) =>
                current.map((item) =>
                  item.id === changed.id ? changed : item,
                ),
              )
            }
            profileId={aggregate.profile.id}
            professions={professions}
            project={project}
          />
        ))
      )}
    </section>
  );
}

function CreateProjectForm({
  client,
  onCreated,
  profileId,
  professions,
}: {
  readonly client: CraftsmanPortfolioClient;
  readonly onCreated: (project: OwnedPortfolioProject) => void;
  readonly profileId: string;
  readonly professions: CraftsmanAuthoringAggregate["professions"];
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [contribution, setContribution] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempt = useRef<{ commandId: string; projectId: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected.length === 0) {
      setMessage("Vyberte aspoň jednu aktívnu profesiu.");
      return;
    }
    attempt.current ??= {
      commandId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
    };
    setBusy(true);
    const result = await client.createProject({
      commandId: attempt.current.commandId,
      contribution: contribution.trim() || null,
      portfolioProjectId: attempt.current.projectId,
      professionIds: selected,
      profileId,
      shortDescription: description.trim(),
      title: title.trim(),
    });
    setBusy(false);
    if (result.status !== "APPLIED") {
      setMessage(mutationMessage(result));
      return;
    }
    attempt.current = null;
    setTitle("");
    setDescription("");
    setContribution("");
    setSelected([]);
    setMessage(null);
    onCreated(result.value);
  }

  return (
    <Card className="profile-authoring-card">
      <form
        className="profile-authoring-form"
        onSubmit={(event) => void submit(event)}
      >
        <SectionHeader
          eyebrow="Nová realizácia"
          title="Pridať súkromný projekt"
        />
        <TrustBadge provenance="declared">Uvádza remeselník</TrustBadge>
        <FormField label="Názov projektu">
          <Input
            id="portfolio-new-title"
            maxLength={120}
            minLength={2}
            onChange={(event) => {
              setTitle(event.target.value);
              attempt.current = null;
            }}
            required
            value={title}
          />
        </FormField>
        <FormField label="Krátky popis">
          <Textarea
            id="portfolio-new-description"
            maxLength={600}
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
          description="Pri tímovej práci stručne uveďte, za čo ste zodpovedali."
          label="Váš konkrétny prínos (voliteľné)"
        >
          <Textarea
            id="portfolio-new-contribution"
            maxLength={600}
            onChange={(event) => {
              setContribution(event.target.value);
              attempt.current = null;
            }}
            rows={3}
            value={contribution}
          />
        </FormField>
        <fieldset>
          <legend>Profesie použité na projekte</legend>
          {professions.map((profession) => (
            <label key={profession.id}>
              <input
                checked={selected.includes(profession.id)}
                onChange={(event) => {
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, profession.id]
                      : current.filter((id) => id !== profession.id),
                  );
                  attempt.current = null;
                }}
                type="checkbox"
              />{" "}
              {humanizeCode(profession.professionCode)}
            </label>
          ))}
        </fieldset>
        {message === null ? null : <p role="alert">{message}</p>}
        <Button disabled={busy || professions.length === 0} type="submit">
          {busy ? "Ukladám…" : "Vytvoriť súkromný projekt"}
        </Button>
      </form>
    </Card>
  );
}

function ProjectCard({
  client,
  onChanged,
  profileId,
  professions,
  project,
}: {
  readonly client: CraftsmanPortfolioClient;
  readonly onChanged: (project: OwnedPortfolioProject) => void;
  readonly profileId: string;
  readonly professions: CraftsmanAuthoringAggregate["professions"];
  readonly project: OwnedPortfolioProject;
}) {
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.shortDescription);
  const [contribution, setContribution] = useState(project.contribution ?? "");
  const [selected, setSelected] = useState(project.professionIds);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempt = useRef<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected.length === 0) {
      setMessage("Vyberte aspoň jednu aktívnu profesiu.");
      return;
    }
    attempt.current ??= crypto.randomUUID();
    setBusy(true);
    const result = await client.editProject({
      commandId: attempt.current,
      contribution: contribution.trim() || null,
      expectedRevision: project.revision,
      professionIds: selected,
      profileId,
      projectId: project.id,
      shortDescription: description.trim(),
      title: title.trim(),
    });
    setBusy(false);
    if (result.status !== "APPLIED") {
      setMessage(mutationMessage(result));
      return;
    }
    attempt.current = null;
    setMessage("Zmeny boli uložené.");
    onChanged(result.value);
  }

  const clearAttempt = () => {
    attempt.current = null;
  };
  return (
    <Card className="profile-authoring-card">
      <TrustBadge provenance="declared">Uvádza remeselník</TrustBadge>
      <p className="profile-authoring-note">
        Súkromné · revízia {project.revision}
      </p>
      <form
        className="profile-authoring-form"
        onSubmit={(event) => void save(event)}
      >
        <label htmlFor={`portfolio-title-${project.id}`}>Názov projektu</label>
        <Input
          id={`portfolio-title-${project.id}`}
          maxLength={120}
          minLength={2}
          onChange={(event) => {
            setTitle(event.target.value);
            clearAttempt();
          }}
          required
          value={title}
        />
        <label htmlFor={`portfolio-description-${project.id}`}>
          Krátky popis
        </label>
        <Textarea
          id={`portfolio-description-${project.id}`}
          maxLength={600}
          minLength={10}
          onChange={(event) => {
            setDescription(event.target.value);
            clearAttempt();
          }}
          required
          rows={4}
          value={description}
        />
        <label htmlFor={`portfolio-contribution-${project.id}`}>
          Váš konkrétny prínos
        </label>
        <Textarea
          id={`portfolio-contribution-${project.id}`}
          maxLength={600}
          onChange={(event) => {
            setContribution(event.target.value);
            clearAttempt();
          }}
          rows={3}
          value={contribution}
        />
        <fieldset>
          <legend>Profesie</legend>
          {professions.map((profession) => (
            <label key={profession.id}>
              <input
                checked={selected.includes(profession.id)}
                onChange={(event) => {
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, profession.id]
                      : current.filter((id) => id !== profession.id),
                  );
                  clearAttempt();
                }}
                type="checkbox"
              />{" "}
              {humanizeCode(profession.professionCode)}
            </label>
          ))}
        </fieldset>
        {message === null ? null : <p role="status">{message}</p>}
        <Button disabled={busy} type="submit">
          {busy ? "Ukladám…" : "Uložiť projekt"}
        </Button>
      </form>
      <ProjectPhotos client={client} profileId={profileId} project={project} />
    </Card>
  );
}

function ProjectPhotos({
  client,
  profileId,
  project,
}: {
  readonly client: CraftsmanPortfolioClient;
  readonly profileId: string;
  readonly project: OwnedPortfolioProject;
}) {
  const [photoSet, setPhotoSet] = useState<OwnedPortfolioPhotoSet | null>(null);
  const [upload, setUpload] = useState<PortfolioPhotoUpload | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<PortfolioPhotoPhase>("AFTER");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attachAttempt = useRef<{
    attachmentId: string;
    commandId: string;
    mediaAssetId: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const [photos, uploads] = await Promise.all([
      client.listPhotos(profileId, project.id),
      client.listUploads(profileId, project.id),
    ]);
    if (photos.status === "READY") setPhotoSet(photos.value);
    if (uploads.status === "READY" && uploads.value.length > 0) {
      const attached = new Set(
        photos.status === "READY"
          ? photos.value.photos.map((photo) => photo.mediaAssetId)
          : [],
      );
      const pending = uploads.value.find(
        (candidate) => !attached.has(candidate.assetId),
      );
      setUpload(pending ?? null);
    }
  }, [client, profileId, project.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (upload?.status !== "PROCESSING") return;
    const timer = window.setTimeout(() => void refresh(), 1_500);
    return () => window.clearTimeout(timer);
  }, [refresh, upload]);

  async function startUpload() {
    if (file === null) return;
    setBusy(true);
    const result = await client.uploadPhoto({
      file,
      profileId,
      projectId: project.id,
      projectRevision: project.revision,
    });
    setBusy(false);
    if (result.status !== "APPLIED") {
      setMessage(mutationMessage(result));
      return;
    }
    setUpload(result.value);
    setFile(null);
    setMessage("Fotografiu bezpečne spracúvame.");
  }

  async function attach() {
    if (upload?.status !== "READY") return;
    if (attachAttempt.current?.mediaAssetId !== upload.assetId) {
      attachAttempt.current = {
        attachmentId: crypto.randomUUID(),
        commandId: crypto.randomUUID(),
        mediaAssetId: upload.assetId,
      };
    }
    setBusy(true);
    const result = await client.attachPhoto({
      attachmentId: attachAttempt.current.attachmentId,
      commandId: attachAttempt.current.commandId,
      expectedRevision: photoSet?.revision ?? 0,
      mediaAssetId: upload.assetId,
      phase,
      profileId,
      projectId: project.id,
    });
    setBusy(false);
    if (result.status !== "APPLIED") {
      setMessage(mutationMessage(result));
      return;
    }
    attachAttempt.current = null;
    setPhotoSet(result.value);
    setUpload(null);
    setMessage("Fotografia bola pridaná do súkromného projektu.");
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setMessage(null);
  }

  const photoCount = photoSet?.photos.length ?? 0;
  const photoLimitReached = photoCount >= 15;

  return (
    <section aria-labelledby={`portfolio-photos-${project.id}`}>
      <SectionHeader
        eyebrow={`${photoCount} z 15 fotografií`}
        title="Fotografie"
      />
      <PortfolioPhotoPrivacyNotice />
      {photoSet?.photos.length ? (
        <ul className="profile-authoring-list">
          {photoSet.photos.map((photo) => (
            <li key={photo.attachmentId}>
              <figure>
                <img
                  alt={`${project.title} — ${phaseLabel(photo.phase)}`}
                  height={Math.min(photo.canonicalHeight, 240)}
                  loading="lazy"
                  src={photo.downloadPath}
                  width={Math.min(photo.canonicalWidth, 360)}
                />
                <figcaption>{phaseLabel(photo.phase)}</figcaption>
              </figure>
            </li>
          ))}
        </ul>
      ) : (
        <p>Zatiaľ nie je pripojená fotografia.</p>
      )}
      <div className="profile-authoring-form">
        <label htmlFor={`portfolio-file-${project.id}`}>
          Vybrať fotografiu
        </label>
        <Input
          accept="image/jpeg,image/png,image/heic,image/heif"
          disabled={
            busy || upload?.status === "PROCESSING" || photoLimitReached
          }
          id={`portfolio-file-${project.id}`}
          onChange={chooseFile}
          type="file"
        />
        <Button
          disabled={busy || file === null || photoLimitReached}
          onClick={() => void startUpload()}
          type="button"
        >
          Nahrať fotografiu
        </Button>
        {photoLimitReached ? (
          <p role="status">
            Dosiahli ste limit 15 fotografií pre jednu realizáciu.
          </p>
        ) : null}
        {upload?.status === "PROCESSING" ? (
          <p role="status">Spracúvam fotografiu…</p>
        ) : null}
        {upload?.status === "REJECTED" ? (
          <p role="alert">Fotografia neprešla bezpečnostným spracovaním.</p>
        ) : null}
        {upload?.status === "READY" ? (
          <>
            <label htmlFor={`portfolio-phase-${project.id}`}>
              Fáza projektu
            </label>
            <Select
              id={`portfolio-phase-${project.id}`}
              onChange={(event) =>
                setPhase(event.target.value as PortfolioPhotoPhase)
              }
              value={phase}
            >
              <option value="BEFORE">Pred realizáciou</option>
              <option value="PROGRESS">Priebeh</option>
              <option value="AFTER">Po realizácii</option>
              <option value="OTHER">Iné</option>
            </Select>
            <Button disabled={busy} onClick={() => void attach()} type="button">
              Pridať spracovanú fotografiu
            </Button>
          </>
        ) : null}
        {message === null ? null : <p role="status">{message}</p>}
      </div>
    </section>
  );
}

function mutationMessage(
  result: Exclude<
    PortfolioMutationResult<unknown>,
    { readonly status: "APPLIED" }
  >,
): string {
  if (result.status === "DENIED")
    return "Prihlásenie vypršalo alebo účet nemôže publikovať.";
  if (result.status === "INVALID_REQUEST")
    return "Skontrolujte vyplnené údaje alebo formát fotografie.";
  if (result.status === "NOT_FOUND")
    return "Projekt alebo fotografia sa nenašli.";
  if (result.status === "STALE_STATE")
    return "Projekt sa medzitým zmenil. Obnovte stránku a skúste to znova.";
  return "Operáciu sa nepodarilo dokončiť. Skúste to znova.";
}

function phaseLabel(phase: PortfolioPhotoPhase): string {
  if (phase === "BEFORE") return "Pred realizáciou";
  if (phase === "PROGRESS") return "Priebeh";
  if (phase === "AFTER") return "Po realizácii";
  return "Iné";
}

export function humanizeCode(code: string): string {
  const segment = code.split(/[.:/]/u).at(-1) ?? code;
  const words = segment.replace(/[_-]+/gu, " ").toLocaleLowerCase("sk-SK");
  return words.length === 0
    ? "Položka spravovaná platformou"
    : `${words.charAt(0).toLocaleUpperCase("sk-SK")}${words.slice(1)}`;
}

export function PortfolioProvenanceNotice() {
  return (
    <Notice title="Súkromné a zatiaľ neoverené" tone="warning">
      <p>
        Projekty vytvorené na tejto stránke sú vlastné vyhlásenie. Nejde o
        overenú realizáciu z platformy a fotografie sa týmto krokom
        nezverejňujú.
      </p>
    </Notice>
  );
}

export function PortfolioPhotoPrivacyNotice() {
  return (
    <Notice title="Súkromie fotografií">
      <p>
        Súbory zostávajú súkromné. Systém odstráni EXIF/GPS údaje a sprístupní
        až bezpečne spracovanú verziu. Verejné použitie fotografie nehnuteľnosti
        vyžaduje samostatný výslovný súhlas zákazníka.
      </p>
    </Notice>
  );
}
