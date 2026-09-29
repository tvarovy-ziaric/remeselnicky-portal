import type { Metadata } from "next";

import { CraftsmanPortfolio } from "../../../craftsman-portfolio";
import { AppShell, PageContainer } from "../../../design-system";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Moje portfólio",
};

export default function CraftsmanPortfolioPage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Profil a účet" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <CraftsmanPortfolio />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation current="Profil a účet" />
    </AppShell>
  );
}
