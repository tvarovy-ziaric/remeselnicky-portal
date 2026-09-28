import type { Metadata } from "next";

import { EmailVerificationResult } from "../../email-verification-result";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false },
  title: "Overenie e-mailu",
};

export default function EmailVerificationPage() {
  return <EmailVerificationResult />;
}
