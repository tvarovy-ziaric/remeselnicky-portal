import type { Metadata } from "next";
import React from "react";

import { CustomerShortlistProvider } from "../../customer-shortlist-toggle";
import {
  ActionLink,
  AppShell,
  PageContainer,
  PageHeader,
} from "../../design-system";
import { loadPublicSearchCards } from "../../public-search-card-client";
import { PublicSearchCardList } from "../../public-search-card-view";
import { parsePublicSearchContext } from "../../public-search-context";
import { PublicSearchForm } from "../../public-search-form";
import { PublicHeader, SiteFooter } from "../../site-shell";

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
    <AppShell>
      <PublicHeader />
      <main className="site-main public-search-page" id="main-content">
        <PageContainer className="public-search-shell">
          <PageHeader
            eyebrow="Výber remeselníka"
            lead="Vyberte si remeselníka podľa práce a lokality. Pri každom výsledku ukazujeme iba dostupné fakty a ich pôvod."
            title={
              jobId
                ? "Remeselníci pre vašu zákazku"
                : "Nájdite remeselníka pre svoju prácu"
            }
          />
          <section
            aria-label="Filtre vyhľadávania"
            className="public-search-page__filters"
          >
            <PublicSearchForm
              {...(jobRequestId === undefined ? {} : { jobRequestId })}
              {...(jobId === undefined ? {} : { jobId })}
            />
          </section>
          <section
            aria-labelledby="public-search-results-title"
            className="public-search-page__results"
          >
            <header className="public-search-results-header">
              <div>
                <h2 id="public-search-results-title">Výsledky vyhľadávania</h2>
                {page === null ? null : (
                  <p>
                    Zobrazené na tejto stránke:{" "}
                    <strong>{page.items.length}</strong>
                  </p>
                )}
              </div>
            </header>
            {typeof professionCode !== "string" ? (
              <p className="public-search-page__empty">
                Vyberte profesiu alebo službu a spustite vyhľadávanie.
              </p>
            ) : page === null ? (
              <p className="public-search-page__empty">
                Výsledky sa teraz nedajú načítať. Skúste to znova neskôr.
              </p>
            ) : (
              <CustomerShortlistProvider>
                <PublicSearchCardList
                  cards={page.items}
                  {...(jobRequestId === undefined ? {} : { jobRequestId })}
                  {...(jobId === undefined ? {} : { jobId })}
                />
                {page.nextCursor === null ? null : (
                  <nav
                    aria-label="Stránkovanie výsledkov"
                    className="public-search-pagination"
                  >
                    <ActionLink
                      href={publicSearchNextPageHref({
                        nextCursor: page.nextCursor,
                        searchParameters,
                        ...(jobRequestId === undefined ? {} : { jobRequestId }),
                        ...(jobId === undefined ? {} : { jobId }),
                      })}
                      variant="secondary"
                    >
                      Ďalšie výsledky
                    </ActionLink>
                  </nav>
                )}
              </CustomerShortlistProvider>
            )}
          </section>
        </PageContainer>
      </main>
      <SiteFooter />
    </AppShell>
  );
}

export function publicSearchNextPageHref(input: {
  readonly jobId?: string;
  readonly jobRequestId?: string;
  readonly nextCursor: string;
  readonly searchParameters: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
}): string {
  const parameters = new URLSearchParams();
  for (const [key, raw] of Object.entries(input.searchParameters)) {
    for (const value of typeof raw === "string" ? [raw] : (raw ?? [])) {
      parameters.append(key, value);
    }
  }
  parameters.set("afterProfileId", input.nextCursor);
  if (input.jobId !== undefined && input.jobRequestId === undefined) {
    parameters.set("jobId", input.jobId);
  } else if (input.jobRequestId !== undefined && input.jobId === undefined) {
    parameters.set("jobRequestId", input.jobRequestId);
  }
  return `/remeselnici?${parameters.toString()}`;
}
