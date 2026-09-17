import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JobOperationDetail } from "../../../../../job-operation-detail";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Problém zákazky",
};

export default async function JobIssuePage({
  params,
}: {
  readonly params: Promise<{ jobId: string; issueId: string }>;
}) {
  const { jobId, issueId } = await params;
  if (!uuid.test(jobId) || !uuid.test(issueId)) notFound();
  return (
    <main className="invitation-page">
      <JobOperationDetail jobId={jobId} itemId={issueId} kind="issues" />
    </main>
  );
}
