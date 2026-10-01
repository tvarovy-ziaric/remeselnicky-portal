"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  Notice,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
} from "./design-system";
import {
  buildAdminTaxonomyMapPayload,
  loadAdminTaxonomyCatalog,
  loadAdminTaxonomySuggestionQueue,
  loadSimilarAdminTaxonomyItems,
  mutateAdminTaxonomy,
  type AdminTaxonomyItem,
  type AdminTaxonomyKind,
  type AdminTaxonomySuggestion,
} from "./admin-taxonomy-data";

type View = "SUGGESTIONS" | "CATALOG";
type LoadState = "LOADING" | "OK" | "DENIED" | "UNAVAILABLE";

export function AdminTaxonomyWorkspace() {
  const [view, setView] = useState<View>("SUGGESTIONS");
  const [catalog, setCatalog] = useState<readonly AdminTaxonomyItem[]>([]);
  const [suggestions, setSuggestions] = useState<
    readonly AdminTaxonomySuggestion[]
  >([]);
  const [state, setState] = useState<LoadState>("LOADING");
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<
    string | null
  >(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState("LOADING");
    const [queue, managed] = await Promise.all([
      loadAdminTaxonomySuggestionQueue(),
      loadAdminTaxonomyCatalog(),
    ]);
    if (queue.status !== "OK" || managed.status !== "OK") {
      setState(
        queue.status === "DENIED" || managed.status === "DENIED"
          ? "DENIED"
          : "UNAVAILABLE",
      );
      return;
    }
    setSuggestions(queue.data);
    setCatalog(managed.data);
    setSelectedSuggestionId((current) => {
      const linked =
        typeof window === "undefined"
          ? null
          : linkedSuggestionId(window.location.pathname);
      const desired = current ?? linked;
      return queue.data.some(({ id }) => id === desired)
        ? desired
        : (queue.data[0]?.id ?? null);
    });
    setSelectedCode((current) =>
      managed.data.some(({ code }) => code === current)
        ? current
        : (managed.data[0]?.code ?? null),
    );
    setState("OK");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedSuggestion =
    suggestions.find(({ id }) => id === selectedSuggestionId) ?? null;
  const selectedItem =
    catalog.find(({ code }) => code === selectedCode) ?? null;

  if (state === "LOADING") {
    return <p role="status">Načítavam spravovaný katalóg…</p>;
  }
  if (state !== "OK") {
    return (
      <section className="admin-panel">
        <PageHeader eyebrow="Katalóg" title="Katalóg nie je dostupný" />
        <p role="alert">
          {state === "DENIED"
            ? "Vyžaduje sa oprávnenie admin.taxonomy.manage a čerstvé MFA overenie."
            : "Katalóg sa nepodarilo bezpečne načítať."}
        </p>
      </section>
    );
  }

  return (
    <section className="admin-panel admin-taxonomy">
      <PageHeader
        eyebrow="Spravované referenčné dáta"
        lead={
          <p>
            Profesie, služby a aliasy sa menia novou nemennou verziou katalógu.
            Každá zmena je autorizovaná, auditovaná a vyžaduje čerstvé MFA.
          </p>
        }
        title="Katalóg profesií a služieb"
      />
      <Notice title="Žiadne priame prepisovanie histórie">
        <p>
          Najprv skontrolujte podobné položky. Konfliktný alias sa nezapíše;
          editor ukáže položku, ktorá ho už používa.
        </p>
      </Notice>
      <div className="admin-taxonomy-tabs" role="tablist" aria-label="Katalóg">
        <Button
          aria-selected={view === "SUGGESTIONS"}
          role="tab"
          type="button"
          variant={view === "SUGGESTIONS" ? "primary" : "secondary"}
          onClick={() => setView("SUGGESTIONS")}
        >
          Návrhy ({suggestions.length})
        </Button>
        <Button
          aria-selected={view === "CATALOG"}
          role="tab"
          type="button"
          variant={view === "CATALOG" ? "primary" : "secondary"}
          onClick={() => setView("CATALOG")}
        >
          Aktuálny katalóg ({catalog.length})
        </Button>
      </div>
      {message === null ? null : <p role="status">{message}</p>}
      {view === "SUGGESTIONS" ? (
        <SuggestionWorkspace
          catalog={catalog}
          selected={selectedSuggestion}
          suggestions={suggestions}
          onRefresh={async (nextMessage) => {
            setMessage(nextMessage);
            await refresh();
          }}
          onSelect={setSelectedSuggestionId}
        />
      ) : (
        <CatalogWorkspace
          catalog={catalog}
          selected={selectedItem}
          onRefresh={async (nextMessage) => {
            setMessage(nextMessage);
            await refresh();
          }}
          onSelect={setSelectedCode}
        />
      )}
    </section>
  );
}

function SuggestionWorkspace({
  catalog,
  onRefresh,
  onSelect,
  selected,
  suggestions,
}: Readonly<{
  catalog: readonly AdminTaxonomyItem[];
  onRefresh(message: string): Promise<void>;
  onSelect(id: string): void;
  selected: AdminTaxonomySuggestion | null;
  suggestions: readonly AdminTaxonomySuggestion[];
}>) {
  if (suggestions.length === 0) {
    return (
      <EmptyState
        description="Remeselníci momentálne neposlali žiadny nový návrh."
        title="Fronta návrhov je prázdna"
      />
    );
  }
  return (
    <div className="admin-taxonomy-layout">
      <ul className="admin-taxonomy-list" aria-label="Návrhy na posúdenie">
        {suggestions.map((suggestion) => (
          <li key={suggestion.id}>
            <Button
              aria-current={selected?.id === suggestion.id ? "true" : undefined}
              type="button"
              variant="quiet"
              onClick={() => onSelect(suggestion.id)}
            >
              <strong>{suggestion.proposedName}</strong>
              <span>{kindLabel(suggestion.suggestedKind)}</span>
            </Button>
          </li>
        ))}
      </ul>
      {selected === null ? null : (
        <SuggestionDecision
          catalog={catalog}
          key={selected.id}
          suggestion={selected}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}

function SuggestionDecision({
  catalog,
  onRefresh,
  suggestion,
}: Readonly<{
  catalog: readonly AdminTaxonomyItem[];
  onRefresh(message: string): Promise<void>;
  suggestion: AdminTaxonomySuggestion;
}>) {
  const initialKind = suggestion.suggestedKind ?? "SERVICE";
  const [kind, setKind] = useState<AdminTaxonomyKind>(initialKind);
  const [canonicalCode, setCanonicalCode] = useState(
    `${initialKind === "PROFESSION" ? "PROF" : "SERV"}:`,
  );
  const [name, setName] = useState(suggestion.proposedName);
  const [description, setDescription] = useState(
    suggestion.proposedDescription,
  );
  const [aliases, setAliases] = useState("");
  const [professionCodes, setProfessionCodes] = useState("");
  const [primaryProfessionCode, setPrimaryProfessionCode] = useState("");
  const [mapCode, setMapCode] = useState("");
  const [addProposedNameAsAlias, setAddProposedNameAsAlias] = useState(false);
  const [note, setNote] = useState("");
  const [similar, setSimilar] = useState<readonly AdminTaxonomyItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [localMessage, setLocalMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadSimilarAdminTaxonomyItems(suggestion.proposedName, null).then(
      (result) => {
        if (active && result.status === "OK") setSimilar(result.data);
      },
    );
    return () => {
      active = false;
    };
  }, [suggestion.proposedName]);

  const decide = async (decision: "approve" | "map" | "reject") => {
    if (busy) return;
    setBusy(true);
    setLocalMessage(null);
    const common = {
      commandId: crypto.randomUUID(),
      expectedRevision: suggestion.revision,
    };
    const path = `/v1/admin/taxonomy-suggestions/${encodeURIComponent(suggestion.id)}/${decision}`;
    const payload =
      decision === "approve"
        ? {
            ...common,
            adminDecisionNote: note.trim().length === 0 ? null : note.trim(),
            aliases: splitLines(aliases),
            canonicalCode: canonicalCode.trim().toUpperCase(),
            canonicalDescription:
              description.trim().length === 0 ? null : description.trim(),
            canonicalKind: kind,
            canonicalName: name.trim(),
            primaryProfessionCode:
              kind === "SERVICE"
                ? primaryProfessionCode.trim().toUpperCase()
                : null,
            professionCodes:
              kind === "SERVICE" ? splitCodes(professionCodes) : [],
          }
        : decision === "map"
          ? buildAdminTaxonomyMapPayload({
              ...common,
              addProposedNameAsAlias,
              adminDecisionNote: note.trim(),
              resolvedKind:
                catalog.find(({ code }) => code === mapCode)?.kind ?? kind,
              resolvedTaxonomyCode: mapCode,
            })
          : { ...common, adminDecisionNote: note.trim() };
    const result = await mutateAdminTaxonomy(path, payload);
    setBusy(false);
    if (result.status === "OK") {
      await onRefresh(
        decision === "approve"
          ? "Návrh bol schválený ako nová položka."
          : decision === "map"
            ? "Návrh bol priradený k existujúcej položke."
            : "Návrh bol zamietnutý.",
      );
      return;
    }
    setLocalMessage(mutationMessage(result));
  };

  return (
    <Card className="admin-taxonomy-editor">
      <div className="admin-taxonomy-heading">
        <div>
          <p className="ui-eyebrow">Návrh remeselníka</p>
          <h2>{suggestion.proposedName}</h2>
        </div>
        <StatusBadge tone="warning">Čaká na rozhodnutie</StatusBadge>
      </div>
      <p>{suggestion.proposedDescription}</p>
      <h3>Možné zhody</h3>
      {similar.length === 0 ? (
        <p>Žiadna zjavná podobná položka.</p>
      ) : (
        <ul className="admin-taxonomy-similar">
          {similar.map((item) => (
            <li key={item.code}>
              <Button
                type="button"
                variant="quiet"
                onClick={() => {
                  setMapCode(item.code);
                  setKind(item.kind);
                }}
              >
                {item.name} · {item.code}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="admin-taxonomy-form-grid">
        <FormField label="Typ položky">
          <Select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as AdminTaxonomyKind)
            }
          >
            <option value="PROFESSION">Profesia</option>
            <option value="SERVICE">Služba</option>
          </Select>
        </FormField>
        <FormField label="Kanonický kód">
          <Input
            value={canonicalCode}
            onChange={(event) => setCanonicalCode(event.target.value)}
          />
        </FormField>
        <FormField label="Názov">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </FormField>
        <FormField label="Aliasy" description="Jeden alias na riadok.">
          <Textarea
            rows={3}
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
          />
        </FormField>
        <FormField label="Opis">
          <Textarea
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>
        {kind === "SERVICE" ? (
          <>
            <FormField
              label="Prepojené profesie"
              description="Kódy oddeľte čiarkou."
            >
              <Input
                value={professionCodes}
                onChange={(event) => setProfessionCodes(event.target.value)}
              />
            </FormField>
            <FormField label="Primárna profesia pre smerovanie">
              <Input
                value={primaryProfessionCode}
                onChange={(event) =>
                  setPrimaryProfessionCode(event.target.value)
                }
              />
            </FormField>
          </>
        ) : null}
        <FormField label="Existujúca položka pre priradenie">
          <Select
            value={mapCode}
            onChange={(event) => setMapCode(event.target.value)}
          >
            <option value="">Vyberte položku</option>
            {catalog.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name} · {item.code}
              </option>
            ))}
          </Select>
        </FormField>
        <label className="admin-taxonomy-checkbox">
          <input
            checked={addProposedNameAsAlias}
            type="checkbox"
            onChange={(event) =>
              setAddProposedNameAsAlias(event.target.checked)
            }
          />
          Pridať názov návrhu ako vyhľadávací alias
        </label>
        <FormField
          label="Poznámka administrátora"
          description="Pri priradení alebo zamietnutí je povinná."
        >
          <Textarea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </FormField>
      </div>
      {localMessage === null ? null : <p role="alert">{localMessage}</p>}
      <div className="admin-taxonomy-actions">
        <Button
          disabled={busy}
          type="button"
          onClick={() => void decide("approve")}
        >
          Schváliť ako novú
        </Button>
        <Button
          disabled={busy || mapCode.length === 0 || note.trim().length < 8}
          type="button"
          variant="secondary"
          onClick={() => void decide("map")}
        >
          Priradiť k existujúcej
        </Button>
        <Button
          disabled={busy || note.trim().length < 8}
          type="button"
          variant="destructive"
          onClick={() => void decide("reject")}
        >
          Zamietnuť
        </Button>
      </div>
    </Card>
  );
}

function CatalogWorkspace({
  catalog,
  onRefresh,
  onSelect,
  selected,
}: Readonly<{
  catalog: readonly AdminTaxonomyItem[];
  onRefresh(message: string): Promise<void>;
  onSelect(code: string): void;
  selected: AdminTaxonomyItem | null;
}>) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const key = query.trim().toLocaleLowerCase("sk");
    return key.length === 0
      ? catalog
      : catalog.filter(
          (item) =>
            item.name.toLocaleLowerCase("sk").includes(key) ||
            item.code.toLocaleLowerCase("sk").includes(key) ||
            item.aliases.some((alias) =>
              alias.toLocaleLowerCase("sk").includes(key),
            ),
        );
  }, [catalog, query]);
  return (
    <div className="admin-taxonomy-layout">
      <div>
        <FormField label="Hľadať v katalógu">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </FormField>
        <ul className="admin-taxonomy-list" aria-label="Spravované položky">
          {filtered.map((item) => (
            <li key={item.code}>
              <Button
                aria-current={selected?.code === item.code ? "true" : undefined}
                type="button"
                variant="quiet"
                onClick={() => onSelect(item.code)}
              >
                <strong>{item.name}</strong>
                <span>
                  {kindLabel(item.kind)} · v{item.releaseVersion}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </div>
      {selected === null ? null : (
        <CatalogEditor
          item={selected}
          key={selected.code}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}

function CatalogEditor({
  item,
  onRefresh,
}: Readonly<{
  item: AdminTaxonomyItem;
  onRefresh(message: string): Promise<void>;
}>) {
  const [kind, setKind] = useState(item.kind);
  const [code, setCode] = useState(item.code);
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? "");
  const [aliases, setAliases] = useState(item.aliases.join("\n"));
  const [state, setState] = useState(item.state);
  const [replacedByCode, setReplacedByCode] = useState(
    item.replacedByCode ?? "",
  );
  const [professionCodes, setProfessionCodes] = useState(
    item.professionCodes.join(", "),
  );
  const [primaryProfessionCode, setPrimaryProfessionCode] = useState(
    item.primaryProfessionCode ?? "",
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const result = await mutateAdminTaxonomy(
      `/v1/admin/taxonomy/catalog/${encodeURIComponent(item.code)}/edit`,
      {
        adminReason: reason.trim(),
        aliases: splitLines(aliases),
        canonicalCode: code.trim().toUpperCase(),
        commandId: crypto.randomUUID(),
        description:
          description.trim().length === 0 ? null : description.trim(),
        expectedReleaseVersion: item.releaseVersion,
        kind,
        name: name.trim(),
        primaryProfessionCode:
          kind === "SERVICE"
            ? primaryProfessionCode.trim().toUpperCase()
            : null,
        professionCodes: kind === "SERVICE" ? splitCodes(professionCodes) : [],
        replacedByCode:
          state === "DEPRECATED" ? replacedByCode.trim().toUpperCase() : null,
        state,
      },
    );
    setBusy(false);
    if (result.status === "OK") {
      await onRefresh("Katalóg bol aktivovaný v novej auditovanej verzii.");
      return;
    }
    setMessage(mutationMessage(result));
  };

  return (
    <Card className="admin-taxonomy-editor">
      <div className="admin-taxonomy-heading">
        <div>
          <p className="ui-eyebrow">Kanonická položka</p>
          <h2>{item.name}</h2>
        </div>
        <StatusBadge tone={item.state === "ACTIVE" ? "success" : "warning"}>
          {item.state === "ACTIVE" ? "Aktívna" : "Nahradená"}
        </StatusBadge>
      </div>
      <div className="admin-taxonomy-form-grid">
        <FormField label="Typ">
          <Select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as AdminTaxonomyKind)
            }
          >
            <option value="PROFESSION">Profesia</option>
            <option value="SERVICE">Služba</option>
          </Select>
        </FormField>
        <FormField label="Kanonický kód">
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </FormField>
        <FormField label="Názov">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </FormField>
        <FormField label="Opis">
          <Textarea
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>
        <FormField
          label="Vyhľadávacie aliasy"
          description="Jeden alias na riadok."
        >
          <Textarea
            rows={5}
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
          />
        </FormField>
        <FormField label="Životný cyklus">
          <Select
            value={state}
            onChange={(event) => setState(event.target.value as typeof state)}
          >
            <option value="ACTIVE">Aktívna</option>
            <option value="DEPRECATED">Nahradená</option>
          </Select>
        </FormField>
        {state === "DEPRECATED" ? (
          <FormField label="Nahradená položkou">
            <Input
              value={replacedByCode}
              onChange={(event) => setReplacedByCode(event.target.value)}
            />
          </FormField>
        ) : null}
        {kind === "SERVICE" ? (
          <>
            <FormField label="Prepojené profesie">
              <Input
                value={professionCodes}
                onChange={(event) => setProfessionCodes(event.target.value)}
              />
            </FormField>
            <FormField label="Primárna profesia">
              <Input
                value={primaryProfessionCode}
                onChange={(event) =>
                  setPrimaryProfessionCode(event.target.value)
                }
              />
            </FormField>
          </>
        ) : null}
        <FormField
          label="Dôvod zmeny"
          description="Povinný auditný dôvod, minimálne 8 znakov."
        >
          <Textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </FormField>
      </div>
      {message === null ? null : <p role="alert">{message}</p>}
      <Button
        disabled={busy || reason.trim().length < 8}
        type="button"
        onClick={() => void save()}
      >
        Aktivovať novú verziu
      </Button>
    </Card>
  );
}

function splitLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
function splitCodes(value: string): readonly string[] {
  return value
    .split(/[\s,;]+/u)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}
function kindLabel(kind: AdminTaxonomyKind | null): string {
  return kind === "PROFESSION"
    ? "Profesia"
    : kind === "SERVICE"
      ? "Služba"
      : "Neurčený typ";
}
function mutationMessage(
  result: Exclude<
    Awaited<ReturnType<typeof mutateAdminTaxonomy>>,
    { status: "OK" }
  >,
): string {
  if (result.status === "ALIAS_CONFLICT")
    return `Alias už používa iná položka: ${result.conflicts.join(", ")}.`;
  if (result.status === "AUTH_REQUIRED")
    return "Privilegovaná relácia vypršala. Prihláste sa a dokončite MFA.";
  if (result.status === "DENIED")
    return "Aktuálna relácia nemá oprávnenie admin.taxonomy.manage alebo vypršalo MFA.";
  if (result.status === "CONFLICT")
    return `Zmena nebola použitá (${result.code}). Obnovte katalóg a skontrolujte väzby.`;
  return "Zmenu sa nepodarilo bezpečne vykonať.";
}

function linkedSuggestionId(pathname: string): string | null {
  const match = pathname.match(
    /^\/admin\/taxonomy\/suggestions\/([0-9a-f-]{36})\/?$/iu,
  );
  return match?.[1] ?? null;
}
