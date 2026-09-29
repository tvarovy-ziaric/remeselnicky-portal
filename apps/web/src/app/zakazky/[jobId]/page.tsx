import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "../../../design-system";
import { JobDashboard } from "../../../job-dashboard";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

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
    <AppShell>
      <AuthenticatedHeader current="Zákazky" />
      <main className="invitation-page" id="main-content">
        <JobDashboard jobId={jobId} />
      </main>
      <MobileBottomNavigation current="Zákazky" />
    </AppShell>
  );
}
