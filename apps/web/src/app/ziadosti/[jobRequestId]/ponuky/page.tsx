import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { QuoteComparisonEntry } from "../../../../quote-comparison";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Porovnanie ponúk",
};

export default async function QuoteComparisonPage({
  params,
}: {
  readonly params: Promise<{ jobRequestId: string }>;
}) {
  const { jobRequestId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      jobRequestId,
    )
  )
    notFound();
  return (
    <main className="invitation-page">
      <QuoteComparisonEntry jobRequestId={jobRequestId} />
    </main>
  );
}
