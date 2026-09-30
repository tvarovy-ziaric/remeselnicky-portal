import React, { type ReactNode } from "react";

import { AppShell, Card, PageHeader } from "./design-system";
import { SessionAwareHeader, SiteFooter } from "./site-shell";

export function AuthPageShell({
  children,
  eyebrow,
  lead,
  title,
}: Readonly<{
  children: ReactNode;
  eyebrow: string;
  lead: ReactNode;
  title: string;
}>) {
  return (
    <AppShell>
      <SessionAwareHeader />
      <main className="login-page" id="main-content">
        <Card className="login-shell auth-shell">
          <PageHeader eyebrow={eyebrow} lead={lead} title={title} />
          {children}
        </Card>
      </main>
      <SiteFooter />
    </AppShell>
  );
}
