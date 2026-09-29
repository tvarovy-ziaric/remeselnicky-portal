import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AuthenticatedPageShell } from "../../../../authenticated-page-shell";
import { ConversationEntry } from "../../../../conversation-entry";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Súkromná konverzácia",
};

export default async function ConversationByInvitationPage({
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
    <AuthenticatedPageShell current="Správy">
      <ConversationEntry invitationId={invitationId} />
    </AuthenticatedPageShell>
  );
}
