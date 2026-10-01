import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { AuthenticatedPageShell } from "../../../../../authenticated-page-shell";
import { TaxonomySuggestionDetail } from "../../../../../taxonomy-suggestion-detail";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Návrh katalógu",
};

export default async function TaxonomySuggestionPage({
  params,
}: {
  readonly params: Promise<{ suggestionId: string }>;
}) {
  const { suggestionId } = await params;
  if (!uuid.test(suggestionId)) notFound();
  return (
    <AuthenticatedPageShell current="Profil">
      <TaxonomySuggestionDetail suggestionId={suggestionId} />
    </AuthenticatedPageShell>
  );
}
