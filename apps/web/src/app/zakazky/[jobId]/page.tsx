import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JobDashboard } from "../../../job-dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Potvrdená zákazka",
};

export default async function JobPage({
  params,
}: {
  readonly params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      jobId,
    )
  )
    notFound();
  return (
    <main className="invitation-page">
      <JobDashboard jobId={jobId} />
    </main>
  );
}
