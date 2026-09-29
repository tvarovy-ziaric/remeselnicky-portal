import type { Metadata } from "next";
import React from "react";

import { AppShell, PageContainer, PageHeader } from "../../../design-system";
import { PrivacyCenter } from "../../../privacy-center";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Súkromie a moje údaje",
};

export default function PrivacyPage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Profil a účet" />
      <main className="site-main account-secondary-page" id="main-content">
        <PageContainer className="account-secondary-page__content">
          <PageHeader
            eyebrow="Účet"
            lead="Odošlite žiadosť a sledujte jej spracovanie. Každá žiadosť je samostatný kontrolovaný workflow."
            title="Súkromie a moje údaje"
          />
          <PrivacyCenter />
        </PageContainer>
      </main>
      <MobileBottomNavigation current="Profil a účet" />
    </AppShell>
  );
}
