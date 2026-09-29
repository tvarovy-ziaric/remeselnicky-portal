import type { Metadata } from "next";
import React from "react";

import { AppShell, PageContainer, PageHeader } from "../../../design-system";
import { NotificationCenter } from "../../../notification-center";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Upozornenia",
};

export default function NotificationsPage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Profil a účet" />
      <main className="site-main account-secondary-page" id="main-content">
        <PageContainer className="account-secondary-page__content">
          <PageHeader
            eyebrow="Účet"
            lead="Hlavný prehľad udalostí súvisiacich s dopytmi, zákazkami, správami a bezpečnosťou účtu."
            title="Upozornenia"
          />
          <NotificationCenter />
        </PageContainer>
      </main>
      <MobileBottomNavigation current="Profil a účet" />
    </AppShell>
  );
}
