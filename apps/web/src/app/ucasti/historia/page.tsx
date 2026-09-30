import type { Metadata } from "next";
import React from "react";

import {
  ActionLink,
  AppShell,
  PageContainer,
  PageHeader,
} from "../../../design-system";
import { ParticipantHistory } from "../../../participant-history";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Moja história účasti",
};

export default function ParticipationHistoryPage() {
  return (
    <AppShell>
      <AuthenticatedHeader context="CRAFTSMAN" current="Zákazky" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <PageHeader
              actions={
                <ActionLink href="/ucasti/pozvanky" variant="secondary">
                  Čakajúce pozvánky
                </ActionLink>
              }
              eyebrow="Súkromný prehľad"
              lead={<p>Potvrdené aj ukončené účasti zostávajú v histórii.</p>}
              title="Moja história účasti"
            />
            <ParticipantHistory />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation context="CRAFTSMAN" current="Zákazky" />
    </AppShell>
  );
}
