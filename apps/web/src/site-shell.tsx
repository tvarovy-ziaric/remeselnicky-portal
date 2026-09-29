import React, { type ReactNode } from "react";

import { ActionLink, PageContainer } from "./design-system";

const publicLinks = [
  { href: "/remeselnici", label: "Remeselníci" },
  { href: "/#ako-to-funguje", label: "Ako to funguje" },
] as const;

const authenticatedLinks = [
  { href: "/zakazky", label: "Prehľad" },
  { href: "/dopyt", label: "Dopyty" },
  { href: "/zakazky", label: "Zákazky" },
  { href: "/konverzacie", label: "Správy" },
  { href: "/ucet/profil-remeselnika", label: "Profil a účet" },
] as const;

export function Brand() {
  return (
    <a aria-label="Remeselnícky portál – domov" className="site-brand" href="/">
      <span aria-hidden="true" className="site-brand__mark">
        R
      </span>
      <span>Remeselnícky portál</span>
    </a>
  );
}

export function PublicHeader() {
  return (
    <header className="site-header">
      <PageContainer className="site-header__inner">
        <Brand />
        <nav aria-label="Hlavná navigácia" className="site-nav">
          {publicLinks.map((link) => (
            <a href={link.href} key={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="site-header__actions">
          <ActionLink href="/prihlasenie" variant="quiet">
            Prihlásiť sa
          </ActionLink>
          <ActionLink href="/dopyt">Vytvoriť dopyt</ActionLink>
        </div>
      </PageContainer>
    </header>
  );
}

export function AuthenticatedHeader({
  utility,
}: Readonly<{ utility?: ReactNode }>) {
  return (
    <header className="site-header site-header--authenticated">
      <PageContainer className="site-header__inner">
        <Brand />
        <nav aria-label="Navigácia účtu" className="site-nav">
          {authenticatedLinks.map((link) => (
            <a href={link.href} key={`${link.href}-${link.label}`}>
              {link.label}
            </a>
          ))}
        </nav>
        {utility ? <div className="site-header__utility">{utility}</div> : null}
      </PageContainer>
    </header>
  );
}

export function MobileBottomNavigation({
  current,
}: Readonly<{ current?: string }>) {
  return (
    <nav aria-label="Mobilná navigácia" className="mobile-bottom-nav">
      {authenticatedLinks.slice(0, 5).map((link) => (
        <a
          aria-current={current === link.label ? "page" : undefined}
          href={link.href}
          key={`${link.label}-mobile`}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <PageContainer className="site-footer__inner">
        <Brand />
        <p>Jednoduchšie hľadanie remeselníkov a pokojnejší priebeh zákazky.</p>
        <nav aria-label="Doplnkové informácie">
          <a href="/ucet/sukromie">Súkromie a moje údaje</a>
          <a href="/prihlasenie">Prihlásenie</a>
        </nav>
      </PageContainer>
    </footer>
  );
}
