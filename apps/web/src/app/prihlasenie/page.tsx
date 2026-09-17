import type { Metadata } from "next";

import { LoginForm } from "../../login-form";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Prihlásenie",
};

export default function LoginPage() {
  return <LoginForm />;
}
