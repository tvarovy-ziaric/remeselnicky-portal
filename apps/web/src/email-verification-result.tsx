"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
} from "./auth-onboarding-client";

type ResultState =
  "INVALID" | "LOADING" | "RATE_LIMITED" | "SUCCESS" | "UNAVAILABLE";

export function takeEmailVerificationTokenFromFragment(
  location: Readonly<{ hash: string; pathname: string; search: string }>,
  replaceState: (path: string) => void,
): string | null {
  const hash = location.hash;
  const pathname = location.pathname;
  // This dedicated route has no legitimate query parameters. Remove both the
  // fragment and query before parsing so a malformed link cannot leave a
  // verification secret in browser history, referrers or copied URLs.
  replaceState(pathname);
  if (!hash.startsWith("#") || hash.includes("&")) return null;
  const parameters = new URLSearchParams(hash.slice(1));
  if ([...parameters.keys()].length !== 1 || !parameters.has("token"))
    return null;
  const token = parameters.get("token");
  return token === null || token === "" ? null : token;
}

export function EmailVerificationResult({
  client,
}: {
  readonly client?: AuthOnboardingClient;
}) {
  const auth = useMemo(() => client ?? createAuthOnboardingClient(), [client]);
  const started = useRef(false);
  const inFlight = useRef(false);
  const [state, setState] = useState<ResultState>("LOADING");
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    async function verifyFromFragment() {
      const token = takeEmailVerificationTokenFromFragment(
        window.location,
        (path) => window.history.replaceState(null, "", path),
      );
      if (token === null) {
        setAuthenticated(false);
        setState("INVALID");
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      setAuthenticated(false);
      setState("LOADING");
      const result = await auth.confirmEmail(token);
      if (result.status !== "VERIFIED") {
        setState(
          result.status === "INVALID_OR_EXPIRED"
            ? "INVALID"
            : result.status === "RATE_LIMITED"
              ? "RATE_LIMITED"
              : "UNAVAILABLE",
        );
        inFlight.current = false;
        return;
      }
      const session = await auth.loadSession();
      setAuthenticated(session.status === "READY");
      setState("SUCCESS");
      inFlight.current = false;
    }

    const onHashChange = () => void verifyFromFragment();
    window.addEventListener("hashchange", onHashChange);
    if (!started.current) {
      started.current = true;
      void verifyFromFragment();
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [auth]);

  const text =
    state === "LOADING"
      ? "Overujem odkaz…"
      : state === "SUCCESS"
        ? "E-mail bol úspešne overený."
        : state === "INVALID"
          ? "Overovací odkaz je neplatný alebo už vypršal."
          : state === "RATE_LIMITED"
            ? "Príliš veľa pokusov. Skúste to neskôr."
            : "Overenie teraz nie je dostupné. Skúste to znova neskôr.";

  return (
    <main className="login-page">
      <section className="login-shell">
        <p className="eyebrow">Web Alpha</p>
        <h1>Overenie e-mailu</h1>
        <p aria-live="polite" role={state === "INVALID" ? "alert" : undefined}>
          {text}
        </p>
        {state === "SUCCESS" ? (
          <a href={authenticated ? "/overenie" : "/prihlasenie"}>
            {authenticated ? "Pokračovať v overení účtu" : "Prihlásiť sa"}
          </a>
        ) : null}
      </section>
    </main>
  );
}
