# R3-018 customer Quote comparison

The comparison is a private, customer-only read model over the current `SUBMITTED` revision of each Quote for one owned JobRequest. The repository locks the ACTIVE actor, exact CustomerProfile and JobRequest in one transaction before reading cards. Providers cannot query competitors. Public profile visibility is intentionally not an eligibility source because a submitted commercial record remains bilateral history.

`PLATFORM_STRUCTURED` cards use only their exact current structured content. `EXTERNAL_PDF` cards use only the provider-confirmed current envelope and the exact selected READY, non-revoked private canonical PDF. The response exposes only the existing opaque `/v1/media/:mediaAssetId/download` route; storage keys, hashes and media metadata never cross this boundary.

Missing fields render as `Neuvedené`; empty scope arrays are not interpreted as affirmative scope. External-PDF fields not included in its confirmed envelope remain null rather than being inferred from PDF contents. Trust context is deliberately sparse and factual: identity verification and the current approved, unexpired credential count. It is not a score and does not claim relevance to the request profession.

Neutral receipt chronology is the default. The optional lowest-price order promotes only explicit `FIXED` EUR totals whose VAT is included or whose provider is not VAT-registered. Estimates, ranges and VAT-excluded totals retain neutral chronological order in the tail. No completeness, paid, founder, photo, credential-count or other ranking boost is applied.

The UI initially compares at most three selected cards on a responsive grid and stacks naturally on narrow screens. It offers the existing private conversation link and PDF delivery link. Favoriting is omitted because D15 makes it optional and no durable favorite authority is needed for Alpha. Expiry, withdrawal/staleness and acceptance remain owned by R3-019/R4.
