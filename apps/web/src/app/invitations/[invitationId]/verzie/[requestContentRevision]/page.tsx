import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JobInvitationDetail } from "../../../../../job-invitation-detail";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Aktualizované pozvanie k zákazke",
};

export default async function InvitationVersionPage({
  params,
}: {
  readonly params: Promise<{
    invitationId: string;
    requestContentRevision: string;
  }>;
}) {
  const { invitationId, requestContentRevision: rawRevision } = await params;
  const requestContentRevision = Number(rawRevision);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      invitationId,
    ) ||
    !/^\d+$/u.test(rawRevision) ||
    !Number.isSafeInteger(requestContentRevision) ||
    requestContentRevision < 1
  ) {
    notFound();
  }
  return (
    <main className="invitation-page">
      <JobInvitationDetail
        invitationId={invitationId}
        requestContentRevision={requestContentRevision}
      />
    </main>
  );
}
