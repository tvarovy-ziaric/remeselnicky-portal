"use client";

import Link from "next/link";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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

  if (state === "LOADING") return <p>Načítavam vaše portfólio…</p>;
  if (state === "AUTH") {
    return (
      <section className="profile-authoring-card">
        <h1>Najprv sa prihláste</h1>
        <p>Portfólio je súkromná časť účtu remeselníka.</p>
        <Link href="/prihlasenie">Prejsť na prihlásenie</Link>
      </section>
    );
  }
  if (state === "EMPTY_PROFILE") {
    return (
      <section className="profile-authoring-card">
        <h1>Najprv vytvorte profil remeselníka</h1>
        <Link href="/ucet/profil-remeselnika">Vytvoriť profil</Link>
      </section>
    );
  }
  if (state === "ERROR" || aggregate === null) {
    return (
      <section className="profile-authoring-card">
        <h1>Portfólio sa nepodarilo načítať</h1>
        <button type="button" onClick={() => void load()}>
          Skúsiť znova
        </button>
      </section>
    );
  }

  const professions = aggregate.professions.filter(
    (profession) => profession.state === "ACTIVE",
  );
  return (
    <section className="profile-authoring" aria-labelledby="portfolio-title">
      <p className="eyebrow">Portfólio remeselníka</p>
      <h1 id="portfolio-title">Vaše realizácie</h1>
      <p>
        Projekty vytvorené na tejto stránke sú zatiaľ súkromné a označené ako
        vlastné vyhlásenie — neoverené. Nejde o overenú realizáciu z platformy.
      </p>
      <p>
        <Link href="/ucet/profil-remeselnika">Späť na profil remeselníka</Link>
      </p>
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
      {projects.length === 0 ? (
        <p>Zatiaľ nemáte uloženú realizáciu.</p>
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
    <form
      className="profile-authoring-card profile-authoring-form"
      onSubmit={(event) => void submit(event)}
    >
      <h2>Pridať súkromnú realizáciu</h2>
      <p className="profile-authoring-note">Vlastné vyhlásenie — neoverené</p>
      <label htmlFor="portfolio-new-title">Názov projektu</label>
      <input
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
      <label htmlFor="portfolio-new-description">Krátky popis</label>
      <textarea
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
      <label htmlFor="portfolio-new-contribution">
        Váš konkrétny prínos (voliteľné)
      </label>
      <textarea
        id="portfolio-new-contribution"
        maxLength={600}
        onChange={(event) => {
          setContribution(event.target.value);
          attempt.current = null;
        }}
        rows={3}
        value={contribution}
      />
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
            {profession.professionCode}
          </label>
        ))}
      </fieldset>
      {message === null ? null : <p role="alert">{message}</p>}
      <button disabled={busy || professions.length === 0} type="submit">
        {busy ? "Ukladám…" : "Vytvoriť súkromný projekt"}
      </button>
    </form>
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
    <article className="profile-authoring-card">
      <p className="profile-authoring-badge">Vlastné vyhlásenie — neoverené</p>
      <p className="profile-authoring-note">
        Súkromné · revízia {project.revision}
      </p>
      <form
        className="profile-authoring-form"
        onSubmit={(event) => void save(event)}
      >
        <label htmlFor={`portfolio-title-${project.id}`}>Názov projektu</label>
        <input
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
        <textarea
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
        <textarea
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
              {profession.professionCode}
            </label>
          ))}
        </fieldset>
        {message === null ? null : <p role="status">{message}</p>}
        <button disabled={busy} type="submit">
          {busy ? "Ukladám…" : "Uložiť projekt"}
        </button>
      </form>
      <ProjectPhotos client={client} profileId={profileId} project={project} />
    </article>
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

  return (
    <section aria-labelledby={`portfolio-photos-${project.id}`}>
      <h3 id={`portfolio-photos-${project.id}`}>Fotografie</h3>
      <p className="profile-authoring-note">
        Súbory zostávajú súkromné. Systém odstráni EXIF/GPS údaje a sprístupní
        až bezpečne spracovanú verziu.
      </p>
      {photoSet?.photos.length ? (
        <ul className="profile-authoring-list">
          {photoSet.photos.map((photo) => (
            <li key={photo.attachmentId}>
              <img
                alt={`${project.title} — ${phaseLabel(photo.phase)}`}
                height={Math.min(photo.canonicalHeight, 240)}
                loading="lazy"
                src={photo.downloadPath}
                width={Math.min(photo.canonicalWidth, 360)}
              />
              <span>{phaseLabel(photo.phase)}</span>
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
        <input
          accept="image/jpeg,image/png,image/heic,image/heif"
          disabled={busy || upload?.status === "PROCESSING"}
          id={`portfolio-file-${project.id}`}
          onChange={chooseFile}
          type="file"
        />
        <button
          disabled={busy || file === null}
          onClick={() => void startUpload()}
          type="button"
        >
          Nahrať fotografiu
        </button>
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
            <select
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
            </select>
            <button disabled={busy} onClick={() => void attach()} type="button">
              Pridať spracovanú fotografiu
            </button>
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
