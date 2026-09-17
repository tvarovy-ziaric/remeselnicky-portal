import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JobChangeRevisionDetail } from "../../../../../../../change-orders";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Revízia zmeny zákazky",
};

export default async function ChangeRevisionPage({
  params,
}: {
  params: Promise<{ jobId: string; changeOrderId: string; revisionId: string }>;
}) {
  const { jobId, changeOrderId, revisionId } = await params;
  if (![jobId, changeOrderId, revisionId].every((value) => uuid.test(value)))
    notFound();
  return (
    <main className="invitation-page">
      <JobChangeRevisionDetail
        jobId={jobId}
        changeOrderId={changeOrderId}
        revisionId={revisionId}
      />
    </main>
  );
}
