import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ParticipantDetail } from "../../../../../participant-detail";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Účastník zákazky",
};

export default async function JobParticipantPage({
  params,
}: {
  readonly params: Promise<{ jobId: string; participantId: string }>;
}) {
  const { jobId, participantId } = await params;
  if (!uuid.test(jobId) || !uuid.test(participantId)) notFound();
  return (
    <main className="invitation-page">
      <section className="invitation-detail">
        <p className="eyebrow">Súkromný záznam zákazky</p>
        <h1>Účastník zákazky</h1>
        <ParticipantDetail
          participantId={participantId}
          jobId={jobId}
          context="JOB_PARTY"
        />
      </section>
    </main>
  );
}
