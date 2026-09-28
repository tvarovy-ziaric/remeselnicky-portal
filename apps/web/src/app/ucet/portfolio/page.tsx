import type { Metadata } from "next";

import { CraftsmanPortfolio } from "../../../craftsman-portfolio";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Moje portfólio",
};

export default function CraftsmanPortfolioPage() {
  return (
    <main className="page-shell">
      <CraftsmanPortfolio />
    </main>
  );
}
