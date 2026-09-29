import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadPublicCraftsmanProfile } from "../../../public-craftsman-profile-client";
import { PublicCraftsmanProfileView } from "../../../public-craftsman-profile-page-view";
import { publicProfileMetadata } from "../../../public-craftsman-profile-view";
import {
  isPublicCraftsmanReviewsCursor,
  loadPublicCraftsmanReviews,
} from "../../../public-craftsman-reviews-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProperties {
  readonly params: Promise<{ profileId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({
  params,
}: PageProperties): Promise<Metadata> {
  const { profileId } = await params;
  return publicProfileMetadata(await loadPublicCraftsmanProfile(profileId));
}

export default async function PublicCraftsmanProfilePage({
  params,
  searchParams,
}: PageProperties) {
  const { profileId } = await params;
  const rawCursor = (await searchParams)["reviewsCursor"];
  const reviewsCursor = isPublicCraftsmanReviewsCursor(rawCursor)
    ? rawCursor
    : undefined;
  const [profile, reviews] = await Promise.all([
    loadPublicCraftsmanProfile(profileId),
    loadPublicCraftsmanReviews(profileId, reviewsCursor),
  ]);
  if (profile === null) notFound();

  return <PublicCraftsmanProfileView profile={profile} reviews={reviews} />;
}
