import type { Metadata } from "next";

import { ParticipantInvitationInbox } from "../../../participant-invitation-inbox";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Pozvánky na účasť",
};

export default function ParticipantInvitationsPage() {
  return (
    <main className="invitation-page">
      <section className="invitation-detail">
        <p className="eyebrow">Súkromný prehľad</p>
        <h1>Pozvánky na účasť</h1>
        <p>
          <a href="/ucasti/historia">Moja história účasti</a>
        </p>
        <ParticipantInvitationInbox />
      </section>
    </main>
  );
}
