"use client";

import React, { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
  type AuthOnboardingSession,
} from "./auth-onboarding-client";
import { ActionLink, Button, PageContainer } from "./design-system";
import { NotificationBadge } from "./notification-badge";

export type AccountContext = "CRAFTSMAN" | "CUSTOMER";

const accountContextStorageKey = "remeselnicky-account-context-v1";

const publicLinks = [
  { href: "/remeselnici", label: "Remeselníci" },
  { href: "/#ako-to-funguje", label: "Ako to funguje" },
] as const;

const customerLinks = [
  { href: "/ucet", label: "Prehľad" },
  { href: "/dopyt", label: "Dopyty" },
  { href: "/remeselnici", label: "Remeselníci" },
  { href: "/zakazky", label: "Zákazky" },
  { href: "/konverzacie", label: "Správy" },
] as const;

const craftsmanLinks = [
  { href: "/ucet", label: "Prehľad" },
  { href: "/pozvanky", label: "Pozvánky" },
  { href: "/zakazky", label: "Zákazky" },
  { href: "/ucet/profil-remeselnika", label: "Profil" },
  { href: "/konverzacie", label: "Správy" },
] as const;

export function accountContextForPath(pathname: string): AccountContext | null {
  if (
    pathname === "/dopyt" ||
    pathname.startsWith("/ziadosti/") ||
    pathname === "/remeselnici" ||
    pathname.startsWith("/remeselnici/")
  ) {
    return "CUSTOMER";
  }
  if (
    pathname === "/pozvanky" ||
    pathname.startsWith("/invitations/") ||
    pathname.startsWith("/ucasti/") ||
    pathname.startsWith("/ucet/profil-remeselnika") ||
    pathname.startsWith("/ucet/portfolio") ||
    pathname.startsWith("/ucet/doklady")
  ) {
    return "CRAFTSMAN";
  }
  return null;
}

export function accountNavigation(context: AccountContext) {
  return context === "CRAFTSMAN" ? craftsmanLinks : customerLinks;
}

export function Brand() {
  return (
    <a aria-label="Remeselnícky portál – domov" className="site-brand" href="/">
      <img
        alt=""
        aria-hidden="true"
        className="site-brand__mark"
        height="40"
        src="/brand/logo-symbol.svg"
        width="40"
      />
      <span className="site-brand__wordmark">Remeselnícky portál</span>
    </a>
  );
}

export function PublicHeader({
  suppressActions = false,
}: Readonly<{ suppressActions?: boolean }>) {
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
        {suppressActions ? (
          <span aria-hidden="true" />
        ) : (
          <div className="site-header__actions">
            <ActionLink href="/prihlasenie" variant="quiet">
              Prihlásiť sa
            </ActionLink>
            <ActionLink href="/dopyt">Vytvoriť dopyt</ActionLink>
          </div>
        )}
      </PageContainer>
    </header>
  );
}

export function SessionAwareHeader({
  client,
  current,
}: Readonly<{
  client?: AuthOnboardingClient;
  current?: string;
}>) {
  const auth = useMemo(() => client ?? createAuthOnboardingClient(), [client]);
  const [state, setState] = useState<
    | { readonly kind: "ANONYMOUS" }
    | { readonly kind: "LOADING" }
    | { readonly kind: "READY"; readonly session: AuthOnboardingSession }
  >({ kind: "LOADING" });

  useEffect(() => {
    let active = true;
    void auth.loadSession().then((result) => {
      if (!active) return;
      setState(
        result.status === "READY"
          ? { kind: "READY", session: result.session }
          : { kind: "ANONYMOUS" },
      );
    });
    return () => {
      active = false;
    };
  }, [auth]);

  return state.kind === "READY" ? (
    <AuthenticatedHeader
      {...(current === undefined ? {} : { current })}
      session={state.session}
    />
  ) : (
    <PublicHeader suppressActions={state.kind === "LOADING"} />
  );
}

export function AuthenticatedHeader({
  context: initialContext,
  current,
  session: suppliedSession,
  utility,
}: Readonly<{
  context?: AccountContext;
  current?: string;
  session?: AuthOnboardingSession;
  utility?: ReactNode;
}>) {
  const auth = useMemo(() => createAuthOnboardingClient(), []);
  const context = useAccountContext(initialContext);
  const [session, setSession] = useState<AuthOnboardingSession | null>(
    suppliedSession ?? null,
  );
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (suppliedSession !== undefined) {
      setSession(suppliedSession);
      return;
    }
    let active = true;
    void auth.loadSession().then((result) => {
      if (active && result.status === "READY") setSession(result.session);
    });
    return () => {
      active = false;
    };
  }, [auth, suppliedSession]);

  async function signOut() {
    if (session === null || signingOut) return;
    setSigningOut(true);
    const result = await auth.logout(session.csrfToken);
    if (result.status === "SIGNED_OUT") {
      window.location.assign("/");
      return;
    }
    setSigningOut(false);
  }

  return (
    <header className="site-header site-header--authenticated">
      <PageContainer className="site-header__inner">
        <Brand />
        <nav aria-label="Navigácia účtu" className="site-nav">
          {accountNavigation(context).map((link) => (
            <a
              aria-current={current === link.label ? "page" : undefined}
              href={link.href}
              key={`${context}-${link.href}-${link.label}`}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="site-header__utility">
          <AccountContextSwitch context={context} />
          <NotificationBadge />
          {utility}
          <Button
            className="session-logout"
            disabled={session === null || signingOut}
            onClick={() => void signOut()}
            type="button"
            variant="quiet"
          >
            {signingOut ? "Odhlasujem…" : "Odhlásiť sa"}
          </Button>
        </div>
      </PageContainer>
    </header>
  );
}

export function AccountContextSwitch({
  context,
}: Readonly<{ context: AccountContext }>) {
  return (
    <nav
      aria-label="Prepnúť spôsob používania účtu"
      className="account-context-switch"
    >
      <a
        aria-current={context === "CUSTOMER" ? "page" : undefined}
        href="/dopyt"
        onClick={() => storeAccountContext("CUSTOMER")}
      >
        Zákazník
      </a>
      <a
        aria-current={context === "CRAFTSMAN" ? "page" : undefined}
        href="/ucet/profil-remeselnika"
        onClick={() => storeAccountContext("CRAFTSMAN")}
      >
        Remeselník
      </a>
    </nav>
  );
}

export function MobileBottomNavigation({
  context: initialContext,
  current,
}: Readonly<{ context?: AccountContext; current?: string }>) {
  const context = useAccountContext(initialContext);
  return (
    <nav aria-label="Mobilná navigácia" className="mobile-bottom-nav">
      {accountNavigation(context)
        .slice(0, 5)
        .map((link) => (
          <a
            aria-current={current === link.label ? "page" : undefined}
            href={link.href}
            key={`${context}-${link.label}-mobile`}
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
          <a href="/ucet">Môj účet</a>
        </nav>
      </PageContainer>
    </footer>
  );
}

function useAccountContext(initialContext?: AccountContext): AccountContext {
  const [context, setContext] = useState<AccountContext>(
    initialContext ?? "CUSTOMER",
  );

  useEffect(() => {
    const contextual = accountContextForPath(window.location.pathname);
    let stored: string | null;
    try {
      stored = window.localStorage.getItem(accountContextStorageKey);
    } catch {
      stored = null;
    }
    const next =
      contextual ??
      initialContext ??
      (stored === "CUSTOMER" || stored === "CRAFTSMAN" ? stored : "CUSTOMER");
    setContext(next);
    if (contextual !== null) storeAccountContext(contextual);
  }, [initialContext]);

  return context;
}

function storeAccountContext(context: AccountContext): void {
  try {
    window.localStorage.setItem(accountContextStorageKey, context);
  } catch {
    // Navigation remains valid when storage is unavailable.
  }
}
