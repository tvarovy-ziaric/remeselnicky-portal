import type { Metadata } from "next";
import React from "react";

import { AppShell, PageContainer, PageHeader } from "../../design-system";
import { JobInvitationInbox } from "../../job-invitation-inbox";
import { AuthenticatedHeader, MobileBottomNavigation } from "../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Moje pozvania",
};

export default function InvitationsPage() {
  return (
    <AppShell>
      <AuthenticatedHeader context="CRAFTSMAN" current="Pozvánky" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <PageHeader
              eyebrow="Súkromný prehľad"
              lead={<p>Pozvania k dopytom a ich aktuálny stav.</p>}
              title="Moje pozvania"
            />
            <JobInvitationInbox />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation context="CRAFTSMAN" current="Pozvánky" />
    </AppShell>
  );
}
