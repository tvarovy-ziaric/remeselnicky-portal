import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { QuoteAcceptanceRecap } from "../../../../../../quote-acceptance-recap";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Záverečná kontrola ponuky",
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default async function QuoteAcceptanceRecapPage({
  params,
}: {
  readonly params: Promise<{ jobRequestId: string; quoteId: string }>;
}) {
  const { jobRequestId, quoteId } = await params;
  if (!uuid.test(jobRequestId) || !uuid.test(quoteId)) notFound();
  return (
    <main className="invitation-page">
      <QuoteAcceptanceRecap jobRequestId={jobRequestId} quoteId={quoteId} />
    </main>
  );
}
