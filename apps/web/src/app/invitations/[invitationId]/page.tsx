import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { AppShell, PageContainer } from "../../../design-system";
import { JobInvitationDetail } from "../../../job-invitation-detail";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Pozvanie k zákazke",
};

export default async function InvitationPage({
  params,
}: {
  readonly params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      invitationId,
    )
  ) {
    notFound();
  }
  return (
    <AppShell>
      <AuthenticatedHeader current="Dopyty" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <JobInvitationDetail invitationId={invitationId} />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation current="Dopyty" />
    </AppShell>
  );
}
