import type { Metadata } from "next";
import type { ReactNode } from "react";

import { appInfo } from "../app-info";
import { FrontendErrorTracking } from "../telemetry-client";
import { NotificationBadge } from "../notification-badge";
import "./styles.css";

export const metadata: Metadata = {
  description: appInfo.description,
  title: appInfo.name,
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="sk">
      <body>
        <FrontendErrorTracking>
          <NotificationBadge />
          {children}
        </FrontendErrorTracking>
      </body>
    </html>
  );
}
