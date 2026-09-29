import type { Metadata } from "next";
import React from "react";

import {
  ActionLink,
  AppShell,
  PageContainer,
  PageHeader,
} from "../../design-system";
import { JobDashboardList } from "../../job-dashboard-list";
import { AuthenticatedHeader, MobileBottomNavigation } from "../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Moje zákazky",
};

export default function JobsPage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Zákazky" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <PageHeader
              actions={
                <ActionLink href="/dopyt" variant="secondary">
                  Vytvoriť dopyt
                </ActionLink>
              }
              eyebrow="Súkromný prehľad"
              lead={
                <p>Potvrdené zákazky a ich aktuálny stav na jednom mieste.</p>
              }
              title="Moje zákazky"
            />
            <JobDashboardList />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation current="Zákazky" />
    </AppShell>
  );
}
