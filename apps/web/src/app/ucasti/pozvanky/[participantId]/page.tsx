import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ParticipantDetail } from "../../../../participant-detail";

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
    <main className="invitation-page">
      <section className="invitation-detail">
        <p className="eyebrow">Súkromná pozvánka</p>
        <h1>Účasť na zákazke</h1>
        <ParticipantDetail participantId={participantId} context="INVITATION" />
      </section>
    </main>
  );
}
