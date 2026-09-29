"use client";

import React, {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
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
  StatusBadge,
  TrustBadge,
} from "./design-system";

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

  if (state === "LOADING") return <p role="status">Načítavam vaše doklady…</p>;
  if (state === "AUTH") {
    return (
      <EmptyState
        action={<ActionLink href="/prihlasenie">Prihlásiť sa</ActionLink>}
        description="Doklady sú súkromná časť účtu remeselníka."
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
        description="Doklady a oprávnenia sa viažu na váš profil a aktívnu profesiu."
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
        description="Súkromné údaje o dokladoch sme teraz nevedeli bezpečne načítať."
        title="Doklady sa nepodarilo načítať"
      />
    );
  }

  const professions = aggregate.professions.filter(
    (profession) => profession.state === "ACTIVE",
  );
  return (
    <section className="profile-authoring credential-authoring">
      <PageHeader
        actions={
          <ActionLink href="/ucet/profil-remeselnika" variant="secondary">
            Späť na profil
          </ActionLink>
        }
        eyebrow="Súkromná kontrola kvalifikácie"
        lead={
          <p>
            Nahrajte doklad k aktívnej profesii a sledujte stav manuálnej
            kontroly.
          </p>
        }
        title="Doklady a oprávnenia"
      />
      <Notice title="Podklad zostáva súkromný">
        <p>
          Samotný súbor dokladu je určený iba na oprávnenú kontrolu platformou.
          Nový doklad nie je overený, kým ho administrátor neschváli.
        </p>
      </Notice>
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
      <SectionHeader
        eyebrow={`${claims.length} ${claims.length === 1 ? "doklad" : "dokladov"}`}
        title="Stav vašich dokladov"
      />
      {claims.length === 0 ? (
        <EmptyState
          description="Pridajte doklad iba vtedy, keď platforma ponúka jeho typ pre vašu profesiu."
          title="Zatiaľ nemáte pridaný žiadny doklad"
        />
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
    <Card className="profile-authoring-card">
      <form
        className="credential-form"
        onSubmit={(event) => void submit(event)}
      >
        <SectionHeader eyebrow="Nový podklad" title="Pridať doklad" />
        <FormField label="Aktívna profesia">
          <Select
            required
            value={professionId}
            onChange={(event) => setProfessionId(event.target.value)}
          >
            <option value="">Vyberte profesiu</option>
            {professions.map((profession) => (
              <option key={profession.id} value={profession.id}>
                {humanizeCode(profession.professionCode)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Typ dokladu spravovaný platformou">
          <Select
            required
            value={typeCode}
            onChange={(event) => setTypeCode(event.target.value)}
          >
            <option value="">Vyberte typ dokladu</option>
            {types.map((type) => (
              <option key={type.code} value={type.code}>
                {humanizeCode(type.code)} —{" "}
                {type.evidenceRequirement === "REQUIRED"
                  ? "povinný podklad"
                  : "voliteľný podklad"}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Platnosť do (voliteľné)">
          <Input
            type="date"
            value={expiresOn}
            onChange={(event) => setExpiresOn(event.target.value)}
          />
        </FormField>
        {notice === null ? null : <p role="alert">{notice}</p>}
        <Button
          disabled={busy || professions.length === 0 || types.length === 0}
          type="submit"
        >
          {busy ? "Ukladám…" : "Pridať doklad na kontrolu"}
        </Button>
      </form>
    </Card>
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

  return (
    <Card className="profile-authoring-card credential-card">
      <p className="ui-eyebrow">{humanizeCode(professionCode)}</p>
      <h2>{humanizeCode(claim.credentialTypeCode)}</h2>
      <CredentialStatusPresentation state={claim.state} />
      <p>
        {claim.evidenceRequirement === "REQUIRED"
          ? "Povinný podklad"
          : "Voliteľný podklad"}
        {claim.expiresOn === null ? "" : ` · platnosť do ${claim.expiresOn}`}
      </p>
      <p>
        Priložené súkromné podklady: <strong>{claim.evidence.length}</strong>
      </p>
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
              <Input
                accept="application/pdf,image/jpeg,image/png,image/heic,image/heif"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <Button disabled={busy || file === null} type="submit">
              Nahrať podklad
            </Button>
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
                    <Button
                      disabled={busy}
                      onClick={() => void attach(item)}
                      type="button"
                      variant="secondary"
                    >
                      Priložiť ku kontrole
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {notice === null ? null : <p role="status">{notice}</p>}
    </Card>
  );
}

function credentialStatusTone(
  state: OwnedCredentialClaim["state"],
): "error" | "warning" {
  return state === "PENDING" ? "warning" : "error";
}

export function CredentialStatusPresentation({
  state,
}: Readonly<{ state: OwnedCredentialClaim["state"] }>) {
  const status = credentialStatus({ state });
  return (
    <>
      {state === "APPROVED" ? (
        <TrustBadge provenance="verified">Overený doklad</TrustBadge>
      ) : (
        <StatusBadge tone={credentialStatusTone(state)}>
          {status.title}
        </StatusBadge>
      )}
      <p>{status.description}</p>
    </>
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

export function humanizeCode(code: string): string {
  const segment = code.split(/[.:/]/u).at(-1) ?? code;
  const words = segment.replace(/[_-]+/gu, " ").toLocaleLowerCase("sk-SK");
  return words.length === 0
    ? "Položka spravovaná platformou"
    : `${words.charAt(0).toLocaleUpperCase("sk-SK")}${words.slice(1)}`;
}
