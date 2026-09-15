import type { Metadata } from "next";

import { JobInvitationInbox } from "../../job-invitation-inbox";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Moje pozvania",
};

export default function InvitationsPage() {
  return (
    <main className="invitation-page">
      <section className="invitation-detail">
        <p className="eyebrow">Súkromný prehľad</p>
        <h1>Moje pozvania</h1>
        <JobInvitationInbox />
      </section>
    </main>
  );
}
