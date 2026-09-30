import type { Metadata } from "next";
import React from "react";

import { AccountHome } from "../../account-home";
import { AppShell, PageContainer } from "../../design-system";
import {
  MobileBottomNavigation,
  SessionAwareHeader,
  SiteFooter,
} from "../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Môj účet",
};

export default function AccountPage() {
  return (
    <AppShell>
      <SessionAwareHeader current="Prehľad" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <AccountHome />
          </PageContainer>
        </section>
      </main>
      <SiteFooter />
      <MobileBottomNavigation current="Prehľad" />
    </AppShell>
  );
}
