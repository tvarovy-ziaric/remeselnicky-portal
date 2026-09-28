import type { Metadata } from "next";

import { AccountVerification } from "../../account-verification";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Overenie účtu",
};

export default function AccountVerificationPage() {
  return <AccountVerification />;
}
