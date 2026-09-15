import type { Metadata } from "next";

import { JobRequestForm } from "../../job-request-form";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Nový dopyt",
};

export default function JobRequestPage() {
  return <JobRequestForm />;
}
