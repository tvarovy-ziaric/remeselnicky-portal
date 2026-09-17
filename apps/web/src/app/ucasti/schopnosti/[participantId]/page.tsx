import type { Metadata } from "next";

import { ParticipantCapabilities } from "../../../../participant-capabilities";

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
    <main className="invitation-page">
      <section className="invitation-detail">
        <p className="eyebrow">Súkromný záznam účasti</p>
        <h1>Profesie a zručnosti na zákazke</h1>
        <ParticipantCapabilities participantId={participantId} />
      </section>
    </main>
  );
}
