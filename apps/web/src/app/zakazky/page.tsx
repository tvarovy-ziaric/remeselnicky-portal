import type { Metadata } from "next";

import { JobDashboardList } from "../../job-dashboard-list";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Moje zákazky",
};

export default function JobsPage() {
  return (
    <main className="invitation-page">
      <section className="invitation-detail">
        <p className="eyebrow">Súkromný prehľad</p>
        <h1>Moje zákazky</h1>
        <JobDashboardList />
      </section>
    </main>
  );
}
