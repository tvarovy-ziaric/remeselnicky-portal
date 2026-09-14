import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadPublicCraftsmanProfile } from "../../../public-craftsman-profile-client";
import {
  formatEurCents,
  priceModeLabel,
  proficiencyLabel,
  publicProfileMetadata,
} from "../../../public-craftsman-profile-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProperties {
  readonly params: Promise<{ profileId: string }>;
}

export async function generateMetadata({
  params,
}: PageProperties): Promise<Metadata> {
  const { profileId } = await params;
  return publicProfileMetadata(await loadPublicCraftsmanProfile(profileId));
}

export default async function PublicCraftsmanProfilePage({
  params,
}: PageProperties) {
  const { profileId } = await params;
  const profile = await loadPublicCraftsmanProfile(profileId);
  if (profile === null) notFound();

  return (
    <main className="public-profile">
      <article className="public-profile-card">
        <header className="public-profile-identity">
          <p className="eyebrow">Verejný profil remeselníka</p>
          <h1>{profile.identity.primaryName}</h1>
          {profile.identity.secondaryName === null ? null : (
            <p className="public-profile-secondary">
              {profile.identity.secondaryName}
            </p>
          )}
          <p>{profile.identity.about}</p>
        </header>

        <section
          aria-labelledby="professions-title"
          className="profile-section"
        >
          <h2 id="professions-title">Profesie</h2>
          <ul className="profile-list">
            {profile.professions.map((profession) => (
              <li key={profession.code}>
                <strong>{profession.label}</strong>
                <span>
                  Deklarovaná úroveň:{" "}
                  {proficiencyLabel(profession.declaredProficiency.level)}
                </span>
                <span>
                  Dokladovaná úroveň:{" "}
                  {profession.evidenceSupportedProficiency === null
                    ? "zatiaľ nepotvrdená"
                    : proficiencyLabel(
                        profession.evidenceSupportedProficiency.level,
                      )}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="location-title" className="profile-section">
          <h2 id="location-title">Pôsobisko</h2>
          <p>
            {profile.location.baseMunicipality.name}, bežný okruh približne{" "}
            {Math.round(profile.location.normalRadiusMeters / 1_000)} km
          </p>
          {profile.location.extraMunicipalities.length === 0 ? null : (
            <p>
              Ďalšie oblasti:{" "}
              {profile.location.extraMunicipalities
                .map(({ name }) => name)
                .join(", ")}
            </p>
          )}
        </section>

        <section aria-labelledby="trust-title" className="profile-section">
          <h2 id="trust-title">Dôveryhodnosť</h2>
          <ul className="trust-facts">
            {profile.trust.identityVerified ? (
              <li>Identita overená platformou</li>
            ) : null}
            {profile.trust.companyRegistrationVerified ? (
              <li>Firemná registrácia overená</li>
            ) : null}
            {profile.trust.customerScore === null ? null : (
              <li>
                Zákaznícke skóre: {profile.trust.customerScore.toFixed(1)} z 5
              </li>
            )}
            <li>{profile.trust.reviewCount} zákazníckych hodnotení</li>
            <li>{profile.trust.verifiedWorkCount} overených realizácií</li>
          </ul>
          <div className="platform-cta">
            <strong>Chcete osloviť remeselníka?</strong>
            <span>Kontakt prebieha bezpečne cez Remeselnícky portál.</span>
          </div>
        </section>

        {profile.portfolio.length === 0 ? null : (
          <section
            aria-labelledby="portfolio-title"
            className="profile-section"
          >
            <h2 id="portfolio-title">Realizácie</h2>
          </section>
        )}

        {profile.skills.length === 0 &&
        profile.specializations.length === 0 ? null : (
          <section aria-labelledby="skills-title" className="profile-section">
            <h2 id="skills-title">Zručnosti a špecializácie</h2>
            <ul className="profile-list">
              {profile.skills.map((skill, index) => (
                <li
                  key={`${skill.canonicalCode ?? skill.declared.label}-${index}`}
                >
                  <strong>{skill.declared.label}</strong>
                  <span>Deklarované remeselníkom</span>
                  <span>
                    {skill.evidenceSupported
                      ? "Podporené dôkazom"
                      : "Bez dokladovaného potvrdenia"}
                  </span>
                </li>
              ))}
              {profile.specializations.map((specialization) => (
                <li key={specialization.code}>
                  <strong>{specialization.declared.label}</strong>
                  <span>Deklarované remeselníkom</span>
                  <span>
                    {specialization.evidenceSupported
                      ? "Podporené dôkazom"
                      : "Bez dokladovaného potvrdenia"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {profile.indicativePricing.length === 0 ? null : (
          <section aria-labelledby="prices-title" className="profile-section">
            <h2 id="prices-title">Orientačné ceny</h2>
            <ul className="profile-list">
              {profile.indicativePricing.map((price, index) => (
                <li key={`${price.serviceName}-${index}`}>
                  <strong>{price.serviceName}</strong>
                  <span>
                    {priceModeLabel(price.mode)}{" "}
                    {formatEurCents(price.amountCents)}
                  </span>
                  {price.note === null ? null : <span>{price.note}</span>}
                </li>
              ))}
            </ul>
            <p className="profile-disclaimer">
              Ceny sú nezáväzné orientačné údaje profilu, nie ponuka ani zmluvná
              cena.
            </p>
          </section>
        )}

        {profile.experience === null &&
        profile.credentials.length === 0 ? null : (
          <section
            aria-labelledby="experience-title"
            className="profile-section"
          >
            <h2 id="experience-title">Skúsenosti a oprávnenia</h2>
            {profile.experience === null ? null : (
              <p>
                Remeselník uvádza začiatok praxe v roku{" "}
                {profile.experience.workingSinceYear}.
              </p>
            )}
            <ul className="profile-list">
              {profile.credentials.map((credential, index) => (
                <li
                  key={`${credential.credentialTypeCode}-${credential.professionCode}-${index}`}
                >
                  <strong>{credential.credentialTypeCode}</strong>
                  <span>Overené administrátorom platformy</span>
                  {credential.expiresOn === null ? null : (
                    <span>Platné do {credential.expiresOn}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    </main>
  );
}
