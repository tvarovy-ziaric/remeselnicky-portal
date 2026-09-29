import type { Metadata } from "next";

import { CraftsmanCredentials } from "../../../craftsman-credentials";
import { AppShell, PageContainer } from "../../../design-system";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Doklady remeselníka",
};

export default function CraftsmanCredentialsPage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Profil a účet" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <CraftsmanCredentials />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation current="Profil a účet" />
    </AppShell>
  );
}
