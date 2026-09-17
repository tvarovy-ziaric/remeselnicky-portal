import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JobMilestoneProposalDetail } from "../../../../../job-milestone-context";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Návrh míľnika",
};

export default async function JobMilestoneProposalPage({
  params,
}: {
  readonly params: Promise<{ jobId: string; proposalId: string }>;
}) {
  const { jobId, proposalId } = await params;
  if (!uuid.test(jobId) || !uuid.test(proposalId)) notFound();
  return (
    <main className="invitation-page">
      <JobMilestoneProposalDetail jobId={jobId} proposalId={proposalId} />
    </main>
  );
}
