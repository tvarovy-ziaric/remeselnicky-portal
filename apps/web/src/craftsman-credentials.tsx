"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  createCraftsmanCredentialClient,
  type CraftsmanCredentialClient,
  type CredentialEvidenceUpload,
  type OwnedCredentialClaim,
} from "./craftsman-credential-client";
import {
  createCraftsmanProfileAuthoringClient,
  type CraftsmanAuthoringAggregate,
} from "./craftsman-profile-authoring-client";

const defaultCredentialClient = createCraftsmanCredentialClient();
const defaultProfileClient = createCraftsmanProfileAuthoringClient();

export function CraftsmanCredentials({
  client = defaultCredentialClient,
}: {
  readonly client?: CraftsmanCredentialClient;
}) {
  const [aggregate, setAggregate] =
    useState<CraftsmanAuthoringAggregate | null>(null);
  const [claims, setClaims] = useState<readonly OwnedCredentialClaim[]>([]);
  const [types, setTypes] = useState<
    readonly {
      readonly code: string;
      readonly evidenceRequirement: "OPTIONAL" | "REQUIRED";
    }[]
  >([]);
  const [uploads, setUploads] = useState<
    Readonly<Record<string, readonly CredentialEvidenceUpload[]>>
  >({});
  const [state, setState] = useState<
    "AUTH" | "EMPTY_PROFILE" | "ERROR" | "LOADING" | "READY"
  >("LOADING");
  const [message, setMessage] = useState<string | null>(null);

  const refreshUploads = useCallback(
    async (
      profileId: string,
      currentClaims: readonly OwnedCredentialClaim[],
    ) => {
      const pending = currentClaims.filter(
        (claim) => claim.state === "PENDING",
      );
      const results = await Promise.all(
        pending.map(async (claim) => ({
          claimId: claim.id,
          result: await client.listEvidenceUploads({
            claimId: claim.id,
            profileId,
          }),
        })),
      );
      setUploads(
        Object.fromEntries(
          results
            .filter(({ result }) => result.status === "READY")
            .map(({ claimId, result }) => [
              claimId,
              result.status === "READY" ? result.value : [],
            ]),
        ),
      );
    },
    [client],
  );

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
    const result = await client.load(profile.aggregate.profile.id);
    if (result.status !== "READY") {
      setState(result.status === "AUTHENTICATION_REQUIRED" ? "AUTH" : "ERROR");
      return;
    }
    setAggregate(profile.aggregate);
    setClaims(result.value.credentials);
    setTypes(result.value.credentialTypes);
    await refreshUploads(
      profile.aggregate.profile.id,
      result.value.credentials,
    );
    setState("READY");
  }, [client, refreshUploads]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasProcessing = useMemo(
    () =>
      Object.values(uploads).some((items) =>
        items.some((item) => item.status === "PROCESSING"),
      ),
    [uploads],
  );
  useEffect(() => {
    if (!hasProcessing || aggregate === null) return;
    const timer = window.setInterval(() => {
      void refreshUploads(aggregate.profile.id, claims);
    }, 1_800);
    return () => window.clearInterval(timer);
  }, [aggregate, claims, hasProcessing, refreshUploads]);

  if (state === "LOADING") return <p>Načítavam vaše doklady…</p>;
  if (state === "AUTH") {
    return (
      <section className="profile-authoring-card">
        <h1>Najprv sa prihláste</h1>
        <p>Doklady sú súkromná časť účtu remeselníka.</p>
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
        <h1>Doklady sa nepodarilo načítať</h1>
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
    <section
      className="profile-authoring credential-authoring"
      aria-labelledby="credentials-title"
    >
      <p className="eyebrow">Súkromná kontrola kvalifikácie</p>
      <h1 id="credentials-title">Doklady a oprávnenia</h1>
      <p>
        Vyberte iba typ, ktorý spravuje platforma. Nový doklad je súkromný a
        čaká na manuálnu kontrolu administrátorom; dovtedy nie je overený.
      </p>
      <p>
        <Link href="/ucet/profil-remeselnika">Späť na profil remeselníka</Link>
      </p>
      {message === null ? null : <p role="status">{message}</p>}
      <CreateCredentialForm
        client={client}
        onCreated={(created) => {
          const next = [...claims, created];
          setClaims(next);
          setMessage("Doklad bol pridaný a čaká na kontrolu.");
          void refreshUploads(aggregate.profile.id, next);
        }}
        profileId={aggregate.profile.id}
        professions={professions}
        types={types}
      />
      {claims.length === 0 ? (
        <p>Zatiaľ nemáte pridaný žiadny doklad.</p>
      ) : (
        <div className="credential-list">
          {claims.map((claim) => (
            <CredentialCard
              claim={claim}
              client={client}
              key={claim.id}
              onChanged={(changed) => {
                const next = claims.map((item) =>
                  item.id === changed.id ? changed : item,
                );
                setClaims(next);
                setMessage("Podklad bol priložený ku kontrole.");
                void refreshUploads(aggregate.profile.id, next);
              }}
              onUploadsChanged={(nextUploads) =>
                setUploads((current) => ({
                  ...current,
                  [claim.id]: nextUploads,
                }))
              }
              professionCode={
                professions.find(
                  (item) => item.id === claim.craftsmanProfessionId,
                )?.professionCode ?? "Neaktívna profesia"
              }
              profileId={aggregate.profile.id}
              uploads={uploads[claim.id] ?? []}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CreateCredentialForm({
  client,
  onCreated,
  profileId,
  professions,
  types,
}: {
  readonly client: CraftsmanCredentialClient;
  readonly onCreated: (claim: OwnedCredentialClaim) => void;
  readonly profileId: string;
  readonly professions: CraftsmanAuthoringAggregate["professions"];
  readonly types: readonly {
    readonly code: string;
    readonly evidenceRequirement: "OPTIONAL" | "REQUIRED";
  }[];
}) {
  const [professionId, setProfessionId] = useState("");
  const [typeCode, setTypeCode] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!professions.some((item) => item.id === professionId)) {
      setNotice("Vyberte aktívnu profesiu.");
      return;
    }
    if (!types.some((item) => item.code === typeCode)) {
      setNotice("Vyberte typ dokladu ponúkaný platformou.");
      return;
    }
    setBusy(true);
    const result = await client.createClaim({
      craftsmanProfessionId: professionId,
      credentialTypeCode: typeCode,
      expiresOn: expiresOn === "" ? null : expiresOn,
      profileId,
    });
    setBusy(false);
    if (result.status === "APPLIED") {
      setExpiresOn("");
      setNotice(null);
      onCreated(result.value);
    } else {
      setNotice("Doklad sa nepodarilo uložiť. Obnovte údaje a skúste znova.");
    }
  }

  return (
    <form
      className="profile-authoring-card credential-form"
      onSubmit={(event) => void submit(event)}
    >
      <h2>Pridať doklad</h2>
      <label>
        Aktívna profesia
        <select
          required
          value={professionId}
          onChange={(event) => setProfessionId(event.target.value)}
        >
          <option value="">Vyberte profesiu</option>
          {professions.map((profession) => (
            <option key={profession.id} value={profession.id}>
              {profession.professionCode}
            </option>
          ))}
        </select>
      </label>
      <label>
        Typ dokladu spravovaný platformou
        <select
          required
          value={typeCode}
          onChange={(event) => setTypeCode(event.target.value)}
        >
          <option value="">Vyberte typ dokladu</option>
          {types.map((type) => (
            <option key={type.code} value={type.code}>
              {type.code} —{" "}
              {type.evidenceRequirement === "REQUIRED"
                ? "povinný podklad"
                : "voliteľný podklad"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Platnosť do (voliteľné)
        <input
          type="date"
          value={expiresOn}
          onChange={(event) => setExpiresOn(event.target.value)}
        />
      </label>
      {notice === null ? null : <p role="alert">{notice}</p>}
      <button
        disabled={busy || professions.length === 0 || types.length === 0}
        type="submit"
      >
        {busy ? "Ukladám…" : "Pridať doklad na kontrolu"}
      </button>
    </form>
  );
}

function CredentialCard({
  claim,
  client,
  onChanged,
  onUploadsChanged,
  professionCode,
  profileId,
  uploads,
}: {
  readonly claim: OwnedCredentialClaim;
  readonly client: CraftsmanCredentialClient;
  readonly onChanged: (claim: OwnedCredentialClaim) => void;
  readonly onUploadsChanged: (
    uploads: readonly CredentialEvidenceUpload[],
  ) => void;
  readonly professionCode: string;
  readonly profileId: string;
  readonly uploads: readonly CredentialEvidenceUpload[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const attached = new Set(claim.evidence.map((item) => item.mediaAssetId));
  const availableUploads = uploads.filter(
    (upload) => !attached.has(upload.assetId),
  );

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === null) return;
    const mediaKind = file.type === "application/pdf" ? "DOCUMENT" : "IMAGE";
    setBusy(true);
    const result = await client.uploadEvidence({
      claim,
      file,
      mediaKind,
      profileId,
    });
    setBusy(false);
    if (result.status === "APPLIED") {
      onUploadsChanged([result.value, ...uploads]);
      setFile(null);
      setNotice("Podklad bol prijatý na bezpečnostnú kontrolu.");
    } else setNotice("Podklad sa nepodarilo nahrať. Skúste znova.");
  }

  async function attach(item: CredentialEvidenceUpload) {
    setBusy(true);
    const result = await client.attachEvidence({
      claim,
      profileId,
      upload: item,
    });
    setBusy(false);
    if (result.status === "APPLIED") onChanged(result.value);
    else
      setNotice(
        "Podklad sa nepodarilo priložiť. Obnovte údaje a skúste znova.",
      );
  }

  const status = credentialStatus(claim);
  return (
    <article className="profile-authoring-card credential-card">
      <p className="eyebrow">{professionCode}</p>
      <h2>
        <code>{claim.credentialTypeCode}</code>
      </h2>
      <p>
        <strong>{status.title}</strong> {status.description}
      </p>
      <p>
        {claim.evidenceRequirement === "REQUIRED"
          ? "Povinný podklad"
          : "Voliteľný podklad"}
        {claim.expiresOn === null ? "" : ` · platnosť do ${claim.expiresOn}`}
      </p>
      <p>Priložené podklady: {claim.evidence.length}</p>
      {claim.reviewReason === null ? null : (
        <p>Dôvod kontroly: {claim.reviewReason}</p>
      )}
      {claim.state !== "PENDING" ? null : (
        <>
          <form
            className="credential-upload-form"
            onSubmit={(event) => void upload(event)}
          >
            <label>
              PDF alebo fotografia dokladu
              <input
                accept="application/pdf,image/jpeg,image/png,image/heic,image/heif"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <button disabled={busy || file === null} type="submit">
              Nahrať podklad
            </button>
          </form>
          <ul className="credential-upload-list">
            {availableUploads.map((item) => (
              <li key={item.assetId}>
                {item.status === "PROCESSING"
                  ? "Podklad sa bezpečne spracúva."
                  : null}
                {item.status === "REJECTED"
                  ? "Podklad bezpečnostnou kontrolou neprešiel."
                  : null}
                {item.status === "READY" ? (
                  <>
                    Podklad je pripravený na priloženie.{" "}
                    <button
                      disabled={busy}
                      onClick={() => void attach(item)}
                      type="button"
                    >
                      Priložiť ku kontrole
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {notice === null ? null : <p role="status">{notice}</p>}
    </article>
  );
}

export function credentialStatus(claim: Pick<OwnedCredentialClaim, "state">) {
  switch (claim.state) {
    case "APPROVED":
      return {
        title: "Overený doklad.",
        description: "Administrátor doklad schválil.",
      };
    case "REJECTED":
      return {
        title: "Doklad bol zamietnutý.",
        description: "Nie je overený.",
      };
    case "REVOKED":
      return {
        title: "Overenie dokladu bolo odobraté.",
        description: "Doklad nie je overený.",
      };
    case "PENDING":
      return {
        title: "Čaká na kontrolu.",
        description:
          "Doklad čaká na kontrolu administrátorom. Zatiaľ nie je overený.",
      };
  }
}
