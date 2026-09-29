import React, { type ReactNode } from "react";

import { AppShell } from "./design-system";
import { AuthenticatedHeader, MobileBottomNavigation } from "./site-shell";

export function AuthenticatedPageShell({
  children,
  current,
  mainClassName = "invitation-page",
}: Readonly<{
  children: ReactNode;
  current: string;
  mainClassName?: string;
}>) {
  return (
    <AppShell>
      <AuthenticatedHeader current={current} />
      <main className={mainClassName} id="main-content">
        {children}
      </main>
      <MobileBottomNavigation current={current} />
    </AppShell>
  );
}
