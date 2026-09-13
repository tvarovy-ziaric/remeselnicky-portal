"use client";

import { useEffect } from "react";

import { captureFrontendRenderError } from "../telemetry-client";

export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => captureFrontendRenderError(error), [error]);

  return (
    <html lang="sk">
      <body>
        <main>
          <h1>Niečo sa pokazilo</h1>
          <p>Chybu sme zaznamenali. Skúste načítať stránku znova.</p>
          <button onClick={reset} type="button">
            Skúsiť znova
          </button>
        </main>
      </body>
    </html>
  );
}
