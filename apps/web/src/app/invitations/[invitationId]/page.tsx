import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JobInvitationDetail } from "../../../job-invitation-detail";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Pozvanie k zákazke",
};

export default async function InvitationPage({
  params,
}: {
  readonly params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      invitationId,
    )
  ) {
    notFound();
  }
  return (
    <main className="invitation-page">
      <JobInvitationDetail invitationId={invitationId} />
    </main>
  );
}
