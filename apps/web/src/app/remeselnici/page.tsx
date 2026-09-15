import type { Metadata } from "next";

import { CustomerShortlistProvider } from "../../customer-shortlist-toggle";
import { loadPublicSearchCards } from "../../public-search-card-client";
import { PublicSearchCardList } from "../../public-search-card-view";

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
  const parameters = await searchParams;
  const { jobRequestId: rawJobRequestId, ...searchParameters } = parameters;
  const professionCode = searchParameters["professionCode"];
  const jobRequestId =
    typeof rawJobRequestId === "string" && uuid(rawJobRequestId)
      ? rawJobRequestId
      : undefined;
  const page =
    typeof professionCode === "string"
      ? await loadPublicSearchCards(searchParameters)
      : null;
  return (
    <main>
      <h1>Remeselníci pre váš dopyt</h1>
      {typeof professionCode !== "string" ? (
        <p>Najprv vyberte profesiu alebo službu.</p>
      ) : page === null ? (
        <p>Výsledky sa teraz nedajú načítať. Skúste to znova neskôr.</p>
      ) : (
        <CustomerShortlistProvider>
          <PublicSearchCardList
            cards={page.items}
            {...(jobRequestId === undefined ? {} : { jobRequestId })}
          />
        </CustomerShortlistProvider>
      )}
    </main>
  );
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
