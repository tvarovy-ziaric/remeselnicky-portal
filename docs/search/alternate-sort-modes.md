# Alternate search sort modes (R2-010)

`@portal/search/alternate-sort` implements the locked alpha `Nearest` and
`Best rated` alternatives as pure ordering over an already-eligible candidate
pool. It never discovers or adds profiles. Publication/readiness, ACTIVE-owner,
profession, required-credential, availability-filter, and service-area gates
must run first, and the sorter requires an exact one-to-one fact set for the
remaining candidates.

## Nearest

Nearest uses only the authoritative internal metre value from the R2-003
distance fact. It orders measured distances ascending and uses profile UUID as
the stable tie-break for equal measured metre values. Unavailable (`null`)
distances come last but retain their incoming Recommended relative order. It
returns the original candidate objects, so internal metre precision is not
copied into an outward result.

An omitted location makes every distance unavailable rather than negative and
therefore preserves the complete incoming Recommended order. Nearest does not
broaden service radius and cannot re-admit an outside-area, unqualified, hidden,
restricted, or suspended candidate.

## Best rated

Best rated accepts only server-authored rating facts containing all three
required dimensions:

- bounded customer score;
- positive review count;
- sufficient-sample confidence.

The score is sortable only when confidence is sufficient. Sufficient ratings
sort by score descending and review count descending. The sorter does not
derive or expose the confidence threshold; that belongs to the authoritative
trust/review aggregation policy.

An insufficient-sample fact must carry `customerScore: null`. It is never
converted to a zero/default rating and does not participate in score
comparison. Insufficient and unrated profiles preserve their incoming
Recommended relative order. Consequently, the entirely sparse R2 dataset keeps
the Recommended order and new profiles are not assigned a fabricated poor
reputation.

Paid/founder status, completeness, photos, price, number of tags, and all other
decorative or commercial fields are absent from the comparison. The sorter
publishes no weights or coefficients and does not mutate candidate objects.
