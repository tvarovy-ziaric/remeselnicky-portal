import type { Metadata } from "next";
import React from "react";

import {
  ActionLink,
  AppShell,
  EmptyState,
  PageContainer,
} from "../../design-system";
import { AuthenticatedHeader, MobileBottomNavigation } from "../../site-shell";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Správy",
};

export default function ConversationsPage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Správy" />
      <main className="site-main authenticated-empty-page" id="main-content">
        <PageContainer>
          <EmptyState
            action={<ActionLink href="/zakazky">Prejsť na zákazky</ActionLink>}
            description="Konverzácia patrí ku konkrétnej pozvánke alebo zákazke. Otvorte zákazku, v ktorej chcete pokračovať."
            title="Správy nájdete pri zákazke"
          />
        </PageContainer>
      </main>
      <MobileBottomNavigation current="Správy" />
    </AppShell>
  );
}
