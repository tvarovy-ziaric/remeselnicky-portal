import type { Metadata } from "next";

import { PrivacyCenter } from "../../../privacy-center";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Súkromie a moje údaje",
};

export default function PrivacyPage() {
  return (
    <main className="page-shell">
      <PrivacyCenter />
    </main>
  );
}
