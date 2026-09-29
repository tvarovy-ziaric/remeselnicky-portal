import type { Metadata } from "next";
import React from "react";

import { CraftsmanProfileAuthoring } from "../../../craftsman-profile-authoring";
import {
  ActionLink,
  AppShell,
  Card,
  PageContainer,
} from "../../../design-system";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Profil remeselníka",
};

export default function CraftsmanProfilePage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Profil a účet" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <CraftsmanProfileAuthoring />
            <div className="profile-authoring">
              <Card className="profile-authoring-card">
                <p className="ui-eyebrow">Ďalšie časti profilu</p>
                <h2>Ukážte prácu a podložte odbornosť</h2>
                <p>
                  Portfólio a doklady nie sú podmienkou prvého odoslania.
                  Schválené doklady sa od vlastných tvrdení zobrazujú oddelene.
                </p>
                <div className="page-header__actions">
                  <ActionLink href="/ucet/portfolio" variant="secondary">
                    Spravovať súkromné portfólio
                  </ActionLink>
                  <ActionLink href="/ucet/doklady" variant="secondary">
                    Spravovať doklady a oprávnenia
                  </ActionLink>
                </div>
              </Card>
            </div>
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation current="Profil a účet" />
    </AppShell>
  );
}
