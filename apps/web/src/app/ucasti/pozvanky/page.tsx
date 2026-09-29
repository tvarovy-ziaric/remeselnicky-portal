import type { Metadata } from "next";
import React from "react";

import {
  ActionLink,
  AppShell,
  PageContainer,
  PageHeader,
} from "../../../design-system";
import { ParticipantInvitationInbox } from "../../../participant-invitation-inbox";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Pozvánky na účasť",
};

export default function ParticipantInvitationsPage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Zákazky" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <PageHeader
              actions={
                <ActionLink href="/ucasti/historia" variant="secondary">
                  História účasti
                </ActionLink>
              }
              eyebrow="Súkromný prehľad"
              lead={<p>Rozhodnite o čakajúcich pozvánkach na zákazky.</p>}
              title="Pozvánky na účasť"
            />
            <ParticipantInvitationInbox />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation current="Zákazky" />
    </AppShell>
  );
}
