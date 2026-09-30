import React from "react";

import {
  ActionLink,
  AppShell,
  Card,
  PageContainer,
  SectionHeader,
  TrustBadge,
} from "../design-system";
import { PublicHeader, SiteFooter } from "../site-shell";

const customerSteps = [
  {
    title: "Opíšete, čo potrebujete",
    text: "Vyberiete službu, miesto a doplníte podrobnosti. Rozpracovaný dopyt si môžete dokončiť po prihlásení.",
  },
  {
    title: "Vyberiete si remeselníkov",
    text: "Porovnáte verejné profily a sami určíte, koho chcete osloviť.",
  },
  {
    title: "Porovnáte ponuky",
    text: "Rozsah, cena a podmienky zostanú pri ponukách vedľa seba a v zrozumiteľnej podobe.",
  },
  {
    title: "Potvrdíte dohodu",
    text: "Zákazka vznikne až po vašom výbere a potvrdení konkrétnej ponuky.",
  },
] as const;

export default function HomePage() {
  return (
    <AppShell>
      <PublicHeader />
      <main className="site-main home-page" id="main-content">
        <section className="home-hero" aria-labelledby="home-title">
          <PageContainer>
            <div className="home-hero__surface">
              <div className="home-hero__content">
                <p className="ui-eyebrow">Remeselníci pre vašu zákazku</p>
                <h1 id="home-title">
                  Nájdite overeného remeselníka pre svoju zákazku
                </h1>
                <p className="home-hero__lead">
                  Vyhľadajte remeselníka alebo jednoducho opíšte, čo
                  potrebujete. Ponuky, dohoda aj priebeh zákazky zostanú na
                  jednom mieste.
                </p>
                <p className="home-hero__note">
                  Profily remeselníkov sú verejné. Na odoslanie dopytu sa
                  prihlásite; prístup remeselníkov do alfy je na pozvánku.
                </p>
              </div>
              <div className="home-hero__visual" aria-hidden="true">
                <img
                  alt=""
                  height="96"
                  src="/brand/logo-symbol.svg"
                  width="96"
                />
              </div>
            </div>
          </PageContainer>
        </section>

        <section className="home-paths" aria-labelledby="paths-title">
          <PageContainer>
            <SectionHeader
              eyebrow="Vyberte si cestu"
              title="Ako chcete začať?"
            />
            <h2 className="visually-hidden" id="paths-title">
              Cesta zákazníka a remeselníka
            </h2>
            <div className="home-path-grid">
              <Card className="home-path-card home-path-card--customer">
                <img
                  alt=""
                  aria-hidden="true"
                  className="home-path-card__icon"
                  height="30"
                  src="/icons/search.svg"
                  width="30"
                />
                <p className="ui-eyebrow">Hľadám remeselníka</p>
                <h3>Nájdite pomoc pre svoju zákazku</h3>
                <p>
                  Vytvorte dopyt alebo si najprv prezrite remeselníkov podľa
                  služby a lokality. Koho oslovíte, zostáva na vás.
                </p>
                <div className="home-path-card__actions">
                  <ActionLink href="/dopyt">Vytvoriť dopyt</ActionLink>
                  <ActionLink href="/remeselnici" variant="quiet">
                    Prezrieť remeselníkov
                  </ActionLink>
                </div>
              </Card>
              <Card className="home-path-card home-path-card--craftsman">
                <img
                  alt=""
                  aria-hidden="true"
                  className="home-path-card__icon"
                  height="30"
                  src="/icons/users.svg"
                  width="30"
                />
                <p className="ui-eyebrow">Som remeselník</p>
                <h3>Spravujte profil aj zákazky</h3>
                <p>
                  Prihláste sa účtom s pozvánkou. Profil, ponuky, správy a
                  dohodnuté zákazky nájdete po prihlásení na jednom mieste.
                </p>
                <div className="home-path-card__actions">
                  <ActionLink href="/prihlasenie" variant="secondary">
                    Prihlásiť sa
                  </ActionLink>
                </div>
              </Card>
            </div>
          </PageContainer>
        </section>

        <section
          className="home-process"
          id="ako-to-funguje"
          aria-labelledby="process-title"
        >
          <PageContainer>
            <SectionHeader
              eyebrow="Ako to funguje"
              title="Od potreby k dohode v štyroch krokoch"
            />
            <h2 className="visually-hidden" id="process-title">
              Ako funguje dopyt a dohoda
            </h2>
            <ol className="home-process__steps">
              {customerSteps.map((step, index) => (
                <li key={step.title}>
                  <span aria-hidden="true">{index + 1}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </PageContainer>
        </section>

        <section className="home-trust" aria-labelledby="trust-title">
          <PageContainer className="home-trust__layout">
            <div>
              <p className="ui-eyebrow">Dôvera bez skratiek</p>
              <h2 id="trust-title">Vždy uvidíte, odkiaľ informácia pochádza</h2>
              <p>
                Hodnotenia zákazníkov, doložené skúsenosti a údaje overené
                platformou nezlievame do jedného neurčitého odznaku. Pri každom
                signále rozlišujeme jeho pôvod.
              </p>
            </div>
            <ul className="home-trust__legend">
              <li>
                <TrustBadge provenance="verified">Overené</TrustBadge>
                <span>Kontrolu vykonala platforma.</span>
              </li>
              <li>
                <TrustBadge provenance="evidence">Podložené</TrustBadge>
                <span>Informácia má priložený doklad alebo dôkaz.</span>
              </li>
              <li>
                <TrustBadge provenance="declared">Uvedené</TrustBadge>
                <span>Informáciu uvádza samotný remeselník.</span>
              </li>
            </ul>
          </PageContainer>
        </section>

        <section className="home-final-cta" aria-labelledby="final-cta-title">
          <PageContainer>
            <div className="home-final-cta__card">
              <div>
                <p className="ui-eyebrow">Môžete začať nezáväzne</p>
                <h2 id="final-cta-title">Opíšte prácu, ktorú potrebujete</h2>
                <p>
                  Najprv pripravíte dopyt. Remeselníkov oslovíte až podľa
                  vlastného výberu.
                </p>
              </div>
              <ActionLink href="/dopyt">Začať dopyt</ActionLink>
            </div>
          </PageContainer>
        </section>
      </main>
      <SiteFooter />
    </AppShell>
  );
}
