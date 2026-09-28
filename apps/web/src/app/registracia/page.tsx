import type { Metadata } from "next";

import { RegistrationForm } from "../../registration-form";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Registrácia do Web Alpha",
};

export default function RegistrationPage() {
  return <RegistrationForm />;
}
