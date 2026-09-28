import type { Metadata } from "next";
import Link from "next/link";

import { CraftsmanProfileAuthoring } from "../../../craftsman-profile-authoring";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Profil remeselníka",
};

export default function CraftsmanProfilePage() {
  return (
    <main className="page-shell">
      <CraftsmanProfileAuthoring />
      <p>
        <Link href="/ucet/portfolio">Pokračovať do súkromného portfólia</Link>
      </p>
    </main>
  );
}
