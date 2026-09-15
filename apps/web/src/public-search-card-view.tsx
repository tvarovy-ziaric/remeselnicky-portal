import Link from "next/link";
import React from "react";

import { CustomerInvitationButton } from "./customer-invitation-button";
import { CustomerShortlistToggle } from "./customer-shortlist-toggle";

export interface PublicSearchCardViewModel {
  readonly availability: "INDICATIVELY_AVAILABLE" | "NO_POSITIVE_SIGNAL";
  readonly badges: readonly Readonly<{ kind: string; label: string }>[];
  readonly identity: Readonly<{
    primaryName: string;
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
  readonly whyMatched: readonly Readonly<{ kind: string; text: string }>[];
}

export function PublicSearchCardList({
  cards,
  jobRequestId,
}: {
  readonly cards: readonly PublicSearchCardViewModel[];
  readonly jobRequestId?: string;
}) {
  if (cards.length === 0) return <p>Nenašli sa žiadni vhodní remeselníci.</p>;
  return (
    <ol aria-label="Výsledky vyhľadávania">
      {cards.map((card) => (
        <li key={card.profileId}>
          <article aria-labelledby={`craftsman-${card.profileId}`}>
            {card.representativePortfolioImage === null ? null : (
              <img
                alt={`Ukážka práce – ${card.identity.primaryName}`}
                src={`/v1/public/media/${card.representativePortfolioImage.mediaAssetId}`}
              />
            )}
            <h2 id={`craftsman-${card.profileId}`}>
              <Link href={`/remeselnici/${card.profileId}`}>
                {card.identity.primaryName}
              </Link>
            </h2>
            <CustomerShortlistToggle craftsmanProfileId={card.profileId} />
            {jobRequestId === undefined ? null : (
              <CustomerInvitationButton
                craftsmanProfileId={card.profileId}
                jobRequestId={jobRequestId}
              />
            )}
            {card.identity.secondaryName === null ? null : (
              <p>{card.identity.secondaryName}</p>
            )}
            <p>{card.professions.map(({ label }) => label).join(", ")}</p>
            <p>
              {card.location.municipalityName}
              {card.location.approximateDistanceKm === null
                ? ""
                : ` · približne ${card.location.approximateDistanceKm} km`}
            </p>
            {card.rating.score === null ? null : (
              <p>
                Hodnotenie {card.rating.score.toFixed(1)} z 5 (
                {card.rating.reviewCount})
              </p>
            )}
            {card.verifiedWorkCount === 0 ? null : (
              <p>Overené realizácie: {card.verifiedWorkCount}</p>
            )}
            <p>
              {card.availability === "INDICATIVELY_AVAILABLE"
                ? "Orientačne dostupný"
                : "Dostupnosť si dohodnite"}
            </p>
            {card.badges.length === 0 ? null : (
              <ul aria-label="Overené signály">
                {card.badges.map((badge) => (
                  <li key={badge.kind}>{badge.label}</li>
                ))}
              </ul>
            )}
            <h3>Prečo sa zhoduje</h3>
            <ul>
              {card.whyMatched.map((reason) => (
                <li key={reason.kind}>{reason.text}</li>
              ))}
            </ul>
          </article>
        </li>
      ))}
    </ol>
  );
}
