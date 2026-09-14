import type { PublicCraftsmanProfile } from "@portal/domain";
import type { Metadata } from "next";

export function publicProfileMetadata(
  profile: PublicCraftsmanProfile | null,
): Metadata {
  if (profile === null) {
    return {
      robots: { follow: false, index: false, nocache: true },
      title: "Profil nie je dostupný",
    };
  }
  return {
    description: profile.identity.about.slice(0, 160),
    robots: { follow: true, index: true },
    title: `${profile.identity.primaryName} | Remeselnícky portál`,
  };
}

export function proficiencyLabel(level: string): string {
  return (
    {
      ADVANCED: "pokročilá úroveň",
      BEGINNER: "začiatočnícka úroveň",
      MASTER: "majstrovská úroveň",
    }[level] ?? level
  );
}

export function priceModeLabel(mode: string): string {
  return (
    {
      APPROXIMATE: "približne",
      FROM: "od",
      HOURLY: "za hodinu",
      OTHER: "orientačne",
      PER_SQUARE_METER: "za m²",
      PER_UNIT: "za jednotku",
    }[mode] ?? mode
  );
}

export function formatEurCents(amountCents: number): string {
  return new Intl.NumberFormat("sk-SK", {
    currency: "EUR",
    style: "currency",
  }).format(amountCents / 100);
}
