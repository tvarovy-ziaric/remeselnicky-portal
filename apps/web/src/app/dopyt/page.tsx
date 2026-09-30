import type { Metadata } from "next";
import React from "react";

import { AppShell } from "../../design-system";
import { JobRequestForm } from "../../job-request-form";
import { SessionAwareHeader, SiteFooter } from "../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Nový dopyt",
};

export default function JobRequestPage() {
  return (
    <AppShell>
      <SessionAwareHeader current="Dopyty" />
      <JobRequestForm />
      <SiteFooter />
    </AppShell>
  );
}
