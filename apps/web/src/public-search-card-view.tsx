import React from "react";

import { CustomerInvitationButton } from "./customer-invitation-button";
import { CustomerShortlistToggle } from "./customer-shortlist-toggle";
import { SearchResultCard, TrustBadge } from "./design-system";
import { ProviderParticipantInvitationButton } from "./provider-participant-invitation-button";

export type PublicSearchCardBadgeKind =
  | "EVIDENCE_SUPPORTED_PROFESSION"
  | "EVIDENCE_SUPPORTED_SKILL"
  | "EVIDENCE_SUPPORTED_SPECIALIZATION"
  | "VERIFIED_CREDENTIAL"
  | "VERIFIED_PORTFOLIO";

export type PublicSearchCardReasonKind =
  | "AVAILABILITY"
  | "EVIDENCE_TRUST"
  | "GEO"
  | "PROFESSION"
  | "REQUIRED_QUALIFICATION"
  | "SKILL"
  | "SPECIALIZATION";

export interface PublicSearchCardViewModel {
  readonly availability: "INDICATIVELY_AVAILABLE" | "NO_POSITIVE_SIGNAL";
  readonly badges: readonly Readonly<{
    kind: PublicSearchCardBadgeKind;
    label: string;
  }>[];
  readonly identity: Readonly<{
    primaryName: string;
    profileType: "INDIVIDUAL" | "COMPANY";
    secondaryName: string | null;
  }>;
  readonly location: Readonly<{
    approximateDistanceKm: number | null;
    municipalityName: string;
  }>;
  readonly professions: readonly Readonly<{ kind: string; label: string }>[];
  readonly profileId: string;
  readonly rating: Readonly<{ reviewCount: number; score: number | null }>;
  readonly representativePortfolioImage: Readonly<{
    mediaAssetId: string;
  }> | null;
  readonly verifiedWorkCount: number;
  readonly whyMatched: readonly Readonly<{
    kind: PublicSearchCardReasonKind;
    text: string;
  }>[];
}

export function PublicSearchCardList({
  cards,
  jobRequestId,
  jobId,
}: {
  readonly cards: readonly PublicSearchCardViewModel[];
  readonly jobRequestId?: string;
  readonly jobId?: string;
}) {
  if (cards.length === 0) return <p>Nenašli sa žiadni vhodní remeselníci.</p>;
  return (
    <ol aria-label="Výsledky vyhľadávania" className="public-search-results">
      {cards.map((card) => (
        <li key={card.profileId}>
          <SearchResultCard
            actions={
              <>
                <CustomerShortlistToggle craftsmanProfileId={card.profileId} />
                {jobRequestId === undefined || jobId !== undefined ? null : (
                  <CustomerInvitationButton
                    craftsmanProfileId={card.profileId}
                    jobRequestId={jobRequestId}
                  />
                )}
                {jobId === undefined ||
                jobRequestId !== undefined ||
                card.identity.profileType !== "INDIVIDUAL" ? null : (
                  <ProviderParticipantInvitationButton
                    craftsmanProfileId={card.profileId}
                    jobId={jobId}
                    key={`${jobId}:${card.profileId}`}
                    profileType={card.identity.profileType}
                  />
                )}
              </>
            }
            badges={
              card.rating.score === null &&
              card.verifiedWorkCount === 0 &&
              card.badges.length === 0 ? null : (
                <ul aria-label="Dôveryhodnosť a podklady">
                  {card.rating.score === null ? null : (
                    <li>
                      <TrustBadge provenance="verified">
                        Hodnotenie {card.rating.score.toFixed(1)} z 5 (
                        {card.rating.reviewCount})
                      </TrustBadge>
                    </li>
                  )}
                  {card.verifiedWorkCount === 0 ? null : (
                    <li>
                      <TrustBadge provenance="verified">
                        Overené realizácie: {card.verifiedWorkCount}
                      </TrustBadge>
                    </li>
                  )}
                  {card.badges.map((badge) => (
                    <li key={badge.kind}>
                      <TrustBadge provenance={badgeProvenance(badge.kind)}>
                        {badge.label}
                      </TrustBadge>
                    </li>
                  ))}
                </ul>
              )
            }
            facts={
              <>
                <TrustBadge provenance="declared">
                  {card.professions.map(({ label }) => label).join(", ")}
                </TrustBadge>
                <span>
                  {card.location.municipalityName}
                  {card.location.approximateDistanceKm === null
                    ? ""
                    : ` · približne ${card.location.approximateDistanceKm} km`}
                </span>
                <span>
                  {card.availability === "INDICATIVELY_AVAILABLE"
                    ? "Orientačne dostupný"
                    : "Dostupnosť si dohodnite"}
                </span>
              </>
            }
            media={
              card.representativePortfolioImage === null ? null : (
                <figure className="search-result-card__figure">
                  <img
                    alt={`Ukážka z profilu – ${card.identity.primaryName}`}
                    loading="lazy"
                    src={`/v1/public/media/${card.representativePortfolioImage.mediaAssetId}`}
                  />
                  <figcaption>Ukážka z profilu</figcaption>
                </figure>
              )
            }
            profileHref={`/remeselnici/${card.profileId}`}
            reasons={
              <>
                <h3>Prečo sa hodí</h3>
                <ul>
                  {card.whyMatched.map((reason) => (
                    <li key={reason.kind}>{reason.text}</li>
                  ))}
                </ul>
              </>
            }
            summary={card.identity.secondaryName}
            title={card.identity.primaryName}
          />
        </li>
      ))}
    </ol>
  );
}

function badgeProvenance(
  kind: PublicSearchCardBadgeKind,
): "evidence" | "verified" {
  return kind === "VERIFIED_CREDENTIAL" || kind === "VERIFIED_PORTFOLIO"
    ? "verified"
    : "evidence";
}
