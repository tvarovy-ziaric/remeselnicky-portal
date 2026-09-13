import type { Metadata } from "next";
import type { ReactNode } from "react";

import { appInfo } from "../app-info";
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
      <body>{children}</body>
    </html>
  );
}
