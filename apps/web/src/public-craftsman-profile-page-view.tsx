import type { PublicCraftsmanProfile } from "@portal/domain";
import React from "react";

import { CustomerShortlistToggle } from "./customer-shortlist-toggle";
import {
  ActionLink,
  AppShell,
  Card,
  PageContainer,
  ProfileHero,
  SectionHeader,
  Tabs,
  TrustBadge,
} from "./design-system";
import type { PublicCraftsmanReviewsPage } from "./public-craftsman-reviews-client";
import {
  PublicCraftsmanReviews,
  PublicProfessionReviewEvidence,
} from "./public-craftsman-reviews";
import {
  formatEurCents,
  formatIndicativeEurRange,
  portfolioDurationUnitLabel,
  portfolioPhotoPhaseLabel,
  priceModeLabel,
  proficiencyLabel,
  publicPortfolioMediaPath,
} from "./public-craftsman-profile-view";
import { SessionAwareHeader, SiteFooter } from "./site-shell";

export function PublicCraftsmanProfileView({
  profile,
  reviews,
}: Readonly<{
  profile: PublicCraftsmanProfile;
  reviews: PublicCraftsmanReviewsPage | null;
}>) {
  const professionLabels = Object.fromEntries(
    profile.professions.map(({ code, label }) => [code, label]),
  );

  return (
    <AppShell>
      <SessionAwareHeader current="Remeselníci" />
      <main className="public-profile" id="main-content">
        <PageContainer className="public-profile-card">
          <div className="public-profile__hero">
            <CraftsmanProfileHero profile={profile} />
          </div>
          <Tabs
            items={[
              { current: true, href: "#prehlad", label: "Prehľad" },
              { href: "#realizacie", label: "Realizácie" },
              { href: "#hodnotenia", label: "Hodnotenia" },
              { href: "#odbornost", label: "Odbornosť" },
            ]}
            label="Sekcie profilu"
          />

          <div className="public-profile__overview-composition">
            <section
              aria-label="Prehľad"
              className="profile-section profile-section--overview"
              id="prehlad"
            >
              <SectionHeader
                eyebrow="Prehľad"
                title="S čím vám remeselník pomôže"
              />
              <div className="profile-overview-grid">
                <Card className="profile-overview-card">
                  <h3>Profesie</h3>
                  <ul className="profile-list">
                    {profile.professions.map((profession) => (
                      <li key={profession.code}>
                        <strong>{profession.label}</strong>
                        <TrustBadge provenance="declared">
                          {proficiencyLabel(
                            profession.declaredProficiency.level,
                          )}
                        </TrustBadge>
                        {profession.evidenceSupportedProficiency === null ? (
                          <span>Zatiaľ bez dokladovanej úrovne.</span>
                        ) : (
                          <TrustBadge provenance="evidence">
                            {proficiencyLabel(
                              profession.evidenceSupportedProficiency.level,
                            )}
                          </TrustBadge>
                        )}
                        <span>
                          Overené realizácie v profesii:{" "}
                          {profession.verifiedJobCount}
                        </span>
                        <PublicProfessionReviewEvidence
                          customerScore={profession.customerScore}
                          reviewCount={profession.reviewCount}
                        />
                        <span>
                          Odborné hodnotenia z overených zákaziek:{" "}
                          {profession.supervisorEvaluationCount}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>

                <Card className="profile-overview-card">
                  <h3>Pôsobisko</h3>
                  <p>
                    {profile.location.baseMunicipality.name} · bežný okruh
                    približne{" "}
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
                </Card>
              </div>

              {profile.indicativePricing.length === 0 ? null : (
                <Card className="profile-pricing-card">
                  <h3>Orientačné ceny</h3>
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
                    Ceny sú nezáväzné orientačné údaje profilu, nie ponuka ani
                    zmluvná cena.
                  </p>
                </Card>
              )}
            </section>

            <section
              aria-label="Realizácie"
              className="profile-section profile-section--portfolio"
              id="realizacie"
            >
              <SectionHeader
                eyebrow="Portfólio"
                title="Realizácie remeselníka"
              />
              {profile.portfolio.length === 0 ? (
                <p>Zatiaľ tu nie sú zverejnené realizácie.</p>
              ) : (
                <ul className="portfolio-project-list">
                  {profile.portfolio.map((project) => (
                    <li key={project.projectId}>
                      <Card className="portfolio-project-card">
                        {project.photos.length === 0 ? null : (
                          <div
                            aria-label={`Fotografie realizácie ${project.title}`}
                            className="portfolio-gallery"
                          >
                            {project.photos.map((photo) => (
                              <figure key={photo.mediaAssetId}>
                                <a
                                  href={publicPortfolioMediaPath(
                                    photo.mediaAssetId,
                                  )}
                                >
                                  <img
                                    alt={`${project.title} – ${portfolioPhotoPhaseLabel(photo.phase)}`}
                                    height={photo.height}
                                    loading="lazy"
                                    src={publicPortfolioMediaPath(
                                      photo.mediaAssetId,
                                    )}
                                    width={photo.width}
                                  />
                                </a>
                                <figcaption>
                                  {portfolioPhotoPhaseLabel(photo.phase)}
                                </figcaption>
                              </figure>
                            ))}
                          </div>
                        )}
                        <header className="portfolio-project-header">
                          <div>
                            <h3>{project.title}</h3>
                            <p>{project.shortDescription}</p>
                          </div>
                          <TrustBadge provenance="declared">
                            Uvádza remeselník
                          </TrustBadge>
                        </header>
                        <dl className="portfolio-project-facts">
                          {project.contribution === null ? null : (
                            <>
                              <dt>Podiel na realizácii</dt>
                              <dd>{project.contribution}</dd>
                            </>
                          )}
                          {project.materialsAndTechnologies === null ? null : (
                            <>
                              <dt>Materiály a technológie</dt>
                              <dd>{project.materialsAndTechnologies}</dd>
                            </>
                          )}
                          {project.problem === null ? null : (
                            <>
                              <dt>Východiskový problém</dt>
                              <dd>{project.problem}</dd>
                            </>
                          )}
                          {project.solution === null ? null : (
                            <>
                              <dt>Riešenie</dt>
                              <dd>{project.solution}</dd>
                            </>
                          )}
                          {project.duration === null ? null : (
                            <>
                              <dt>Približné trvanie</dt>
                              <dd>
                                {project.duration.value}{" "}
                                {portfolioDurationUnitLabel(
                                  project.duration.unit,
                                )}
                              </dd>
                            </>
                          )}
                          {project.indicativePrice === null ? null : (
                            <>
                              <dt>Nezáväzná orientačná cena</dt>
                              <dd>
                                {formatIndicativeEurRange(
                                  project.indicativePrice.minCents,
                                  project.indicativePrice.maxCents,
                                )}
                              </dd>
                            </>
                          )}
                          {project.approximateLocation === null ? null : (
                            <>
                              <dt>Lokalita</dt>
                              <dd>Približná lokalita uvedená remeselníkom</dd>
                            </>
                          )}
                        </dl>
                        {project.professions.length === 0 ? null : (
                          <p>
                            <strong>Profesie:</strong>{" "}
                            {project.professions
                              .map(({ label }) => label)
                              .join(", ")}
                          </p>
                        )}
                        {project.skills.length === 0 ? null : (
                          <p>
                            <strong>Zručnosti:</strong>{" "}
                            {project.skills
                              .map(({ label }) => label)
                              .join(", ")}
                          </p>
                        )}
                        {project.specializations.length === 0 ? null : (
                          <p>
                            <strong>Špecializácie:</strong>{" "}
                            {project.specializations
                              .map(({ label }) => label)
                              .join(", ")}
                          </p>
                        )}
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div id="hodnotenia">
            <PublicCraftsmanReviews
              page={reviews}
              professionLabels={professionLabels}
              profileId={profile.profileId}
              reviewCount={profile.trust.reviewCount}
            />
          </div>

          <section
            aria-label="Odbornosť"
            className="profile-section"
            id="odbornost"
          >
            <SectionHeader
              eyebrow="Odbornosť"
              title="Zručnosti, skúsenosti a oprávnenia"
            />
            {profile.skills.length === 0 &&
            profile.specializations.length === 0 ? (
              <p>Zatiaľ bez zverejnených zručností a špecializácií.</p>
            ) : (
              <ul className="profile-list">
                {profile.skills.map((skill, index) => (
                  <li
                    key={`${skill.canonicalCode ?? skill.declared.label}-${index}`}
                  >
                    <strong>{skill.declared.label}</strong>
                    <TrustBadge
                      provenance={
                        skill.evidenceSupported ? "evidence" : "declared"
                      }
                    >
                      {skill.evidenceSupported
                        ? "Podporené dôkazmi"
                        : "Uvádza remeselník"}
                    </TrustBadge>
                  </li>
                ))}
                {profile.specializations.map((specialization) => (
                  <li key={specialization.code}>
                    <strong>{specialization.declared.label}</strong>
                    <TrustBadge
                      provenance={
                        specialization.evidenceSupported
                          ? "evidence"
                          : "declared"
                      }
                    >
                      {specialization.evidenceSupported
                        ? "Podporené dôkazmi"
                        : "Uvádza remeselník"}
                    </TrustBadge>
                  </li>
                ))}
              </ul>
            )}

            {profile.experience === null ? null : (
              <Card className="profile-experience-card">
                <h3>Skúsenosti</h3>
                <p>
                  Remeselník uvádza začiatok praxe v roku{" "}
                  {profile.experience.workingSinceYear}.
                </p>
                <TrustBadge provenance="declared">Uvádza remeselník</TrustBadge>
              </Card>
            )}

            {profile.credentials.length === 0 ? null : (
              <Card className="profile-credentials-card">
                <h3>Overené oprávnenia</h3>
                <ul className="profile-list">
                  {profile.credentials.map((credential, index) => (
                    <li
                      key={`${credential.credentialTypeCode}-${credential.professionCode}-${index}`}
                    >
                      <strong>
                        {professionLabels[credential.professionCode] ===
                        undefined
                          ? "Odborné oprávnenie"
                          : `Oprávnenie pre ${professionLabels[credential.professionCode]}`}
                      </strong>
                      <TrustBadge provenance="verified">
                        Schválené platformou
                      </TrustBadge>
                      {credential.expiresOn === null ? null : (
                        <span>Platné do {credential.expiresOn}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </PageContainer>
      </main>
      <SiteFooter />
    </AppShell>
  );
}

export function CraftsmanProfileHero({
  profile,
}: Readonly<{ profile: PublicCraftsmanProfile }>) {
  return (
    <section
      aria-label="Základné informácie o remeselníkovi"
      className="public-profile-hero public-profile-hero--without-portrait"
    >
      <ProfileHero
        actions={
          <>
            {profile.callToAction.kind === "PLATFORM_JOB_REQUEST" ? (
              <span className="profile-hero__primary-action">
                <ActionLink href="/dopyt">Vytvoriť dopyt</ActionLink>
              </span>
            ) : null}
            <span className="profile-hero__secondary-action">
              <CustomerShortlistToggle craftsmanProfileId={profile.profileId} />
            </span>
          </>
        }
        description={
          <>
            <p className="profile-hero__metadata">
              {profile.professions.map(({ label }) => label).join(" · ")}
              {profile.professions.length === 0 ? "" : " · "}
              <span className="profile-hero__location">
                <img
                  alt=""
                  aria-hidden="true"
                  height="18"
                  src="/icons/location.svg"
                  width="18"
                />
                {profile.location.baseMunicipality.name}
              </span>
            </p>
            <p className="profile-hero__about">{profile.identity.about}</p>
          </>
        }
        eyebrow="Verejný profil remeselníka"
        facts={
          <>
            <div aria-label="Overenia profilu" className="profile-hero__trust">
              {profile.trust.identityVerified ? (
                <TrustBadge provenance="verified">Overená identita</TrustBadge>
              ) : null}
              {profile.trust.companyRegistrationVerified ? (
                <TrustBadge provenance="verified">
                  Overená firemná registrácia
                </TrustBadge>
              ) : null}
            </div>
            <p className="profile-disclaimer">
              Kontakt prebieha cez portál. Telefón, e-mail ani presná adresa sa
              pred potvrdením zákazky nezobrazujú.
            </p>
          </>
        }
        subtitle={profile.identity.secondaryName}
        title={profile.identity.primaryName}
      />
      <dl aria-label="Fakty o profile" className="profile-trust-fact-row">
        <div className="profile-trust-fact profile-trust-fact--rating">
          <dt>
            <span aria-hidden="true" className="profile-trust-fact__icon">
              <img
                alt=""
                height="22"
                src={
                  profile.trust.customerScore === null
                    ? "/icons/users.svg"
                    : "/icons/star.svg"
                }
                width="22"
              />
            </span>
            {profile.trust.customerScore === null
              ? "Zákaznícke hodnotenia"
              : "Zákaznícke hodnotenie"}
          </dt>
          <dd>
            {profile.trust.customerScore === null
              ? profile.trust.reviewCount
              : `${profile.trust.customerScore.toFixed(1)} z 5 (${profile.trust.reviewCount})`}
          </dd>
        </div>
        <div className="profile-trust-fact">
          <dt>
            <span aria-hidden="true" className="profile-trust-fact__icon">
              <img
                alt=""
                height="22"
                src="/icons/shield-check.svg"
                width="22"
              />
            </span>
            Overené realizácie
          </dt>
          <dd>{profile.trust.verifiedWorkCount}</dd>
        </div>
        <div className="profile-trust-fact">
          <dt>
            <span aria-hidden="true" className="profile-trust-fact__icon">
              <img alt="" height="22" src="/icons/users.svg" width="22" />
            </span>
            Odborné hodnotenia
          </dt>
          <dd>{profile.trust.supervisorEvaluationCount}</dd>
        </div>
        <div className="profile-trust-fact profile-trust-fact--location">
          <dt>
            <span aria-hidden="true" className="profile-trust-fact__icon">
              <img alt="" height="22" src="/icons/location.svg" width="22" />
            </span>
            Pôsobisko
          </dt>
          <dd>
            {profile.location.baseMunicipality.name} · približne{" "}
            {Math.round(profile.location.normalRadiusMeters / 1_000)} km
          </dd>
        </div>
      </dl>
    </section>
  );
}
