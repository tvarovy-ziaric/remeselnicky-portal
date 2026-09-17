import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JobMilestoneDetail } from "../../../../../job-milestones";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Míľnik zákazky",
};

export default async function JobMilestonePage({
  params,
}: {
  readonly params: Promise<{ jobId: string; milestoneId: string }>;
}) {
  const { jobId, milestoneId } = await params;
  if (!uuid.test(jobId) || !uuid.test(milestoneId)) notFound();
  return (
    <main className="invitation-page">
      <JobMilestoneDetail jobId={jobId} milestoneId={milestoneId} />
    </main>
  );
}
