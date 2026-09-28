import type { Metadata } from "next";

import { CraftsmanCredentials } from "../../../craftsman-credentials";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Doklady remeselníka",
};

export default function CraftsmanCredentialsPage() {
  return (
    <main className="page-shell">
      <CraftsmanCredentials />
    </main>
  );
}
