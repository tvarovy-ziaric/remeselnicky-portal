import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ReceivedSupervisorEvaluationDetail } from "../../../../../../job-supervisor-evaluation";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Odborné hodnotenie",
};

export default async function SupervisorEvaluationPage({
  params,
}: {
  params: Promise<{ jobId: string; evaluationId: string }>;
}) {
  const { jobId, evaluationId } = await params;
  if (!uuid.test(jobId) || !uuid.test(evaluationId)) notFound();
  return (
    <main className="invitation-page">
      <ReceivedSupervisorEvaluationDetail
        jobId={jobId}
        evaluationId={evaluationId}
      />
    </main>
  );
}
