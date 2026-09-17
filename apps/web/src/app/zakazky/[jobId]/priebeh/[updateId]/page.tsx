import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JobOperationDetail } from "../../../../../job-operation-detail";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Priebeh zákazky",
};

export default async function JobProgressPage({
  params,
}: {
  readonly params: Promise<{ jobId: string; updateId: string }>;
}) {
  const { jobId, updateId } = await params;
  if (!uuid.test(jobId) || !uuid.test(updateId)) notFound();
  return (
    <main className="invitation-page">
      <JobOperationDetail jobId={jobId} itemId={updateId} kind="progress" />
    </main>
  );
}
