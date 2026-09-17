"use client";

import { useState, type FormEvent } from "react";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const csrfResponse = await fetch("/v1/auth/csrf", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!csrfResponse.ok) throw new Error("CSRF unavailable");
      const csrf: unknown = await csrfResponse.json();
      if (
        typeof csrf !== "object" ||
        csrf === null ||
        !("csrfToken" in csrf) ||
        typeof csrf.csrfToken !== "string"
      ) {
        throw new Error("Invalid CSRF response");
      }
      const response = await fetch("/v1/auth/login", {
        body: JSON.stringify({ email: email.trim(), password }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf.csrfToken,
        },
        method: "POST",
      });
      if (response.ok) {
        window.location.assign("/dopyt");
        return;
      }
      setMessage(
        response.status === 401
          ? "E-mail alebo heslo nie je správne."
          : response.status === 429
            ? "Príliš veľa pokusov. Skúste to neskôr."
            : "Prihlásenie sa nepodarilo. Skúste to znova.",
      );
    } catch {
      setMessage("Prihlásenie teraz nie je dostupné. Skúste to znova neskôr.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-shell">
        <p className="eyebrow">Dopyt</p>
        <h1>Prihlásenie</h1>
        <p>Pokračujte účtom, ktorý má pozvánku do Web Alpha.</p>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="login-email">E-mail</label>
          <input
            autoComplete="username"
            id="login-email"
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
          <label htmlFor="login-password">Heslo</label>
          <input
            autoComplete="current-password"
            id="login-password"
            maxLength={128}
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          {message === "" ? null : <p role="alert">{message}</p>}
          <button disabled={busy} type="submit">
            {busy ? "Prihlasujem…" : "Prihlásiť sa a pokračovať"}
          </button>
        </form>
      </section>
    </main>
  );
}
