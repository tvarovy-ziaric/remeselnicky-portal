import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";

import { appInfo } from "../app-info";
import { FrontendErrorTracking } from "../telemetry-client";
import "./styles.css";
import "./handoff.css";

const inter = Inter({
  display: "swap",
  subsets: ["latin", "latin-ext"],
  variable: "--font-interface",
});

const sourceSerif = Source_Serif_4({
  display: "swap",
  subsets: ["latin", "latin-ext"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  description: appInfo.description,
  title: appInfo.name,
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html className={`${inter.variable} ${sourceSerif.variable}`} lang="sk">
      <body>
        <FrontendErrorTracking>{children}</FrontendErrorTracking>
      </body>
    </html>
  );
}
