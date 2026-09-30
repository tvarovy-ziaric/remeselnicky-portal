import type { Metadata } from "next";
import React from "react";

import { AppShell, PageContainer, PageHeader } from "../../../../design-system";
import { ParticipantCapabilities } from "../../../../participant-capabilities";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../../site-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Profesie a zručnosti na zákazke",
};

export default async function ParticipantCapabilitiesPage({
  params,
}: {
  params: Promise<{ participantId: string }>;
}) {
  const { participantId } = await params;
  return (
    <AppShell>
      <AuthenticatedHeader context="CRAFTSMAN" current="Zákazky" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <PageHeader
              eyebrow="Súkromný záznam účasti"
              lead={
                <p>
                  Návrhy činností a potvrdenia druhej strany pre túto zákazku.
                </p>
              }
              title="Profesie a zručnosti na zákazke"
            />
            <ParticipantCapabilities participantId={participantId} />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation context="CRAFTSMAN" current="Zákazky" />
    </AppShell>
  );
}
