"use client";

import React, { useEffect, useMemo, useState } from "react";

import { ActionLink, Card, Notice, StatusBadge } from "./design-system";
import {
  createTaxonomySuggestionClient,
  type OwnedTaxonomySuggestion,
  type TaxonomySuggestionClient,
} from "./taxonomy-suggestion-client";

type State =
  | Readonly<{ status: "LOADING" }>
  | Readonly<{ status: "DENIED" | "NOT_FOUND" | "UNAVAILABLE" }>
  | Readonly<{ status: "READY"; suggestion: OwnedTaxonomySuggestion }>;

export function TaxonomySuggestionDetail({
  client,
  suggestionId,
}: {
  readonly client?: TaxonomySuggestionClient;
  readonly suggestionId: string;
}) {
  const api = useMemo(
    () => client ?? createTaxonomySuggestionClient(),
    [client],
  );
  const [state, setState] = useState<State>({ status: "LOADING" });

  useEffect(() => {
    let active = true;
    void api.load(suggestionId).then((result) => {
      if (active) setState(result);
    });
    return () => {
      active = false;
    };
  }, [api, suggestionId]);

  if (state.status === "LOADING") {
    return (
      <Notice title="Načítavam návrh" tone="trust">
        <p aria-live="polite">Načítavam výsledok posúdenia…</p>
      </Notice>
    );
  }
  if (state.status !== "READY") {
    const denied = state.status === "DENIED";
    return (
      <Notice
        title={denied ? "Najprv sa prihláste" : "Návrh nie je dostupný"}
        tone={state.status === "UNAVAILABLE" ? "error" : "warning"}
      >
        <p>
          {denied
            ? "Tento detail je súkromný a dostupný iba vlastníkovi remeselníckeho profilu."
            : "Návrh sa nenašiel alebo sa jeho detail momentálne nedá načítať."}
        </p>
      </Notice>
    );
  }

  const suggestion = state.suggestion;
  const outcome = suggestionOutcome(suggestion);
  return (
    <div className="profile-authoring">
      <Card className="profile-authoring-card">
        <p className="ui-eyebrow">Spravovaný katalóg</p>
        <div className="page-header__title-row">
          <h1>{suggestion.proposedName}</h1>
          <StatusBadge tone={outcome.tone}>{outcome.label}</StatusBadge>
        </div>
        <p>{suggestion.proposedDescription}</p>
        <Notice title={outcome.title} tone={outcome.tone}>
          <p>{outcome.description}</p>
          {suggestion.resolvedTaxonomyCode === null ? null : (
            <p>
              Spravovaná položka:{" "}
              {suggestion.resolvedTaxonomyLabel ?? "Položka katalógu"}{" "}
              <code>{suggestion.resolvedTaxonomyCode}</code>
            </p>
          )}
          {suggestion.adminDecisionNote === null ? null : (
            <p>
              <strong>Správa administrátora:</strong>{" "}
              {suggestion.adminDecisionNote}
            </p>
          )}
        </Notice>
        <p className="ui-secondary-copy">
          Navrhovaný typ: {kindLabel(suggestion.suggestedKind)} · odoslané{" "}
          <time dateTime={suggestion.createdAt}>
            {new Date(suggestion.createdAt).toLocaleString("sk-SK")}
          </time>
        </p>
        <ActionLink href="/ucet/profil-remeselnika" variant="secondary">
          Späť na profil remeselníka
        </ActionLink>
      </Card>
    </div>
  );
}

function suggestionOutcome(suggestion: OwnedTaxonomySuggestion): {
  readonly description: string;
  readonly label: string;
  readonly title: string;
  readonly tone: "default" | "error" | "success" | "warning";
} {
  switch (suggestion.state) {
    case "PENDING":
      return {
        description:
          "Návrh ešte nie je súčasťou katalógu. Administrátor ho posúdi a výsledok dostanete v oznámení.",
        label: "Čaká na posúdenie",
        title: "Návrh sme prijali",
        tone: "warning",
      };
    case "APPROVED_AS_NEW":
      return {
        description: "Návrh sme pridali ako novú spravovanú položku katalógu.",
        label: "Schválené",
        title: "Návrh bol schválený",
        tone: "success",
      };
    case "MAPPED_TO_EXISTING":
      return {
        description:
          "Návrh sme priradili k existujúcej spravovanej položke katalógu.",
        label: "Priradené",
        title: "Použili sme existujúcu položku",
        tone: "success",
      };
    case "REJECTED":
      return {
        description: "Návrh sme do spravovaného katalógu nezaradili.",
        label: "Nezaradené",
        title: "Návrh nebol zaradený",
        tone: "error",
      };
  }
}

function kindLabel(kind: OwnedTaxonomySuggestion["suggestedKind"]): string {
  if (kind === "PROFESSION") return "Profesia";
  if (kind === "SERVICE") return "Služba";
  return "Bez návrhu typu";
}
