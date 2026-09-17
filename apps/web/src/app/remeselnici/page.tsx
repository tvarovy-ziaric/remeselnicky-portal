import type { Metadata } from "next";

import { CustomerShortlistProvider } from "../../customer-shortlist-toggle";
import { loadPublicSearchCards } from "../../public-search-card-client";
import { PublicSearchCardList } from "../../public-search-card-view";
import { parsePublicSearchContext } from "../../public-search-context";
import { PublicSearchForm } from "../../public-search-form";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: true, index: false },
  title: "Vyhľadávanie remeselníkov",
};

interface PageProperties {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CraftsmanSearchPage({
  searchParams,
}: PageProperties) {
  const { jobId, jobRequestId, searchParameters } = parsePublicSearchContext(
    await searchParams,
  );
  const professionCode = searchParameters["professionCode"];
  const page =
    typeof professionCode === "string"
      ? await loadPublicSearchCards(searchParameters)
      : null;
  return (
    <main className="public-search-page">
      <section className="public-search-shell">
        <h1>
          {jobId ? "Remeselníci pre vašu zákazku" : "Vyhľadávanie remeselníkov"}
        </h1>
        <PublicSearchForm
          {...(jobRequestId === undefined ? {} : { jobRequestId })}
          {...(jobId === undefined ? {} : { jobId })}
        />
        {typeof professionCode !== "string" ? (
          <p>Vyberte profesiu alebo službu a spustite vyhľadávanie.</p>
        ) : page === null ? (
          <p>Výsledky sa teraz nedajú načítať. Skúste to znova neskôr.</p>
        ) : (
          <CustomerShortlistProvider>
            <PublicSearchCardList
              cards={page.items}
              {...(jobRequestId === undefined ? {} : { jobRequestId })}
              {...(jobId === undefined ? {} : { jobId })}
            />
          </CustomerShortlistProvider>
        )}
      </section>
    </main>
  );
}
