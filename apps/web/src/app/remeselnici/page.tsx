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
            lead="Vyhľadávajte podľa práce, ktorú potrebujete. Pri každom výsledku ukazujeme iba dostupné fakty a ich pôvod."
            title={
              jobId
                ? "Remeselníci pre vašu zákazku"
                : "Vyhľadávanie remeselníkov"
            }
          />
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
