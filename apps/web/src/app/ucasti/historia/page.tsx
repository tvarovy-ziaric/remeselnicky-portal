import type { Metadata } from "next";

import { ParticipantHistory } from "../../../participant-history";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Moja história účasti",
};

export default function ParticipationHistoryPage() {
  return (
    <main className="invitation-page">
      <section className="invitation-detail">
        <p className="eyebrow">Súkromný prehľad</p>
        <h1>Moja história účasti</h1>
        <p>Potvrdené aj ukončené účasti zostávajú v histórii zákazky.</p>
        <p>
          <a href="/ucasti/pozvanky">Čakajúce pozvánky</a>
        </p>
        <ParticipantHistory />
      </section>
    </main>
  );
}
