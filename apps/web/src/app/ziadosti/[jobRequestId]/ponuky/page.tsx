import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { AppShell, PageContainer, PageHeader } from "../../../../design-system";
import { QuoteComparisonEntry } from "../../../../quote-comparison";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Porovnanie ponúk",
};

export default async function QuoteComparisonPage({
  params,
}: {
  readonly params: Promise<{ jobRequestId: string }>;
}) {
  const { jobRequestId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      jobRequestId,
    )
  )
    notFound();
  return (
    <AppShell>
      <AuthenticatedHeader current="Dopyty" />
      <main className="site-main quote-comparison-page" id="main-content">
        <PageContainer>
          <PageHeader
            eyebrow="Ponuky k dopytu"
            lead="Porovnajte rozsah, cenu, termín a podmienky. Portál neurčuje víťaza — výber zostáva na vás."
            title="Porovnanie ponúk"
          />
          <QuoteComparisonEntry jobRequestId={jobRequestId} />
        </PageContainer>
      </main>
      <MobileBottomNavigation current="Dopyty" />
    </AppShell>
  );
}
