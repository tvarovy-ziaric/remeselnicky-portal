import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  robots: {
    follow: false,
    index: false,
    nocache: true,
  },
  title: "Interná administrácia",
};

export default function AdminLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return children;
}
