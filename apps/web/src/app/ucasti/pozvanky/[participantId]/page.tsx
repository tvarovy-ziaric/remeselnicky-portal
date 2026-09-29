import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { AppShell, PageContainer, PageHeader } from "../../../../design-system";
import { ParticipantDetail } from "../../../../participant-detail";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../../site-shell";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Pozvánka k účasti",
};

export default async function ParticipantInvitationPage({
  params,
}: {
  readonly params: Promise<{ participantId: string }>;
}) {
  const { participantId } = await params;
  if (!uuid.test(participantId)) notFound();
  return (
    <AppShell>
      <AuthenticatedHeader current="Zákazky" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <PageHeader
              eyebrow="Súkromná pozvánka"
              lead={<p>Skontrolujte kontext a rozhodnite o svojej účasti.</p>}
              title="Účasť na zákazke"
            />
            <ParticipantDetail
              participantId={participantId}
              context="INVITATION"
            />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation current="Zákazky" />
    </AppShell>
  );
}
