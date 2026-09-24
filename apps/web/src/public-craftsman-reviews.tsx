import React from "react";

import {
  publicCraftsmanReviewDimensions,
  type PublicCraftsmanReviewsPage,
} from "./public-craftsman-reviews-client";

export function PublicCraftsmanReviews({
  page,
  profileId,
  professionLabels,
  reviewCount,
}: {
  readonly page: PublicCraftsmanReviewsPage | null;
  readonly profileId: string;
  readonly professionLabels: Readonly<Record<string, string>>;
  readonly reviewCount: number;
}) {
  return (
    <section aria-labelledby="reviews-title" className="profile-section">
      <h2 id="reviews-title">Hodnotenia</h2>
      <p className="profile-disclaimer">
        {reviewCount === 1
          ? "1 hodnotenie od overeného zákazníka"
          : `${reviewCount} hodnotení od overených zákazníkov`}
      </p>
      {page === null ? (
        <p>Hodnotenia sa momentálne nedajú načítať.</p>
      ) : page.reviews.length === 0 ? (
        <p>Zatiaľ bez zákazníckych hodnotení.</p>
      ) : (
        <ol className="public-review-list">
          {page.reviews.map((review) => (
            <li key={review.reviewId}>
              <header className="public-review-header">
                <strong>Overený zákazník</strong>
                <span>
                  {professionLabels[review.professionCode] ??
                    "Profesia zákazky"}
                </span>
                <span>{formatReviewedMonth(review.reviewedMonth)}</span>
                <strong>{formatScore(review.score)} z 5</strong>
              </header>
              <dl className="public-review-dimensions">
                {publicCraftsmanReviewDimensions.map(([field, label]) => (
                  <React.Fragment key={field}>
                    <dt>{label}</dt>
                    <dd>
                      {review.ratings[field] === null
                        ? "Neviem posúdiť / netýka sa"
                        : `${String(review.ratings[field])} z 5`}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
              {review.comment === null ? null : (
                <blockquote>{review.comment}</blockquote>
              )}
            </li>
          ))}
        </ol>
      )}
      {page?.nextCursor === null || page === null ? null : (
        <a
          className="public-review-next"
          href={`/remeselnici/${encodeURIComponent(profileId)}?reviewsCursor=${encodeURIComponent(page.nextCursor)}`}
        >
          Ďalšie hodnotenia
        </a>
      )}
    </section>
  );
}

export function PublicProfessionReviewEvidence({
  customerScore,
  reviewCount,
}: {
  readonly customerScore: number | null;
  readonly reviewCount: number;
}) {
  return (
    <>
      <span>Zákaznícke hodnotenia v profesii: {reviewCount}</span>
      {customerScore === null ? null : (
        <span>
          Zákaznícke skóre v profesii: {formatScore(customerScore)} z 5
        </span>
      )}
    </>
  );
}

export function formatReviewedMonth(value: string): string {
  return new Intl.DateTimeFormat("sk-SK", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}-01T00:00:00.000Z`));
}

function formatScore(value: number): string {
  return new Intl.NumberFormat("sk-SK", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(value);
}
