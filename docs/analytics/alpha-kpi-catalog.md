# Alpha KPI catalog (D28_ALPHA_V1)

Status: R4-027 implementation contract for synthetic-test operation. The
executable source of truth is `packages/analytics/src/alpha-dashboard.ts`.
Changing a formula or denominator requires a new definition version; dashboards
must never silently mix versions.

## Cohort and privacy rules

- The reporting interval is half-open: `submitted_at/occurred_at >= from` and
  `< to`. A request remains in its original submission cohort as later outcomes
  arrive.
- Requests and Jobs are counted by unique opaque IDs, never by raw event count.
- TEST dominates INTERNAL, which dominates REAL, across the customer and every
  invited provider. Marketplace KPIs include REAL rows only.
- Supply is a current snapshot with one row per public
  profile/profession/region; activity is attributed to the request/accepted-Job
  profession. A multi-profession profile counts once in the total profile KPI.
- Profession/region segments are publishable only when their unique-entity
  cohort reaches the configured floor (default 5). Smaller cohorts stay
  suppressed or are coarsened.
- Facts contain no chat/review/dispute text, exact address, contact data,
  documents, filenames, coordinates or raw search query.

## Core funnel

| KPI                             | Formula / denominator                                                   |
| ------------------------------- | ----------------------------------------------------------------------- |
| `requests_submitted`            | Distinct submitted `request_id`; count metric.                          |
| `requests_with_engagement_rate` | Requests with first ENGAGED invitation / submitted requests.            |
| `requests_with_quote_rate`      | Requests with first submitted Quote / submitted requests.               |
| `requests_confirmed_rate`       | Requests with a confirmed `job_id` / submitted requests.                |
| `confirmed_jobs_completed_rate` | Distinct completed Jobs / distinct confirmed Jobs.                      |
| `completed_jobs_reviewed_rate`  | Completed Jobs with at least one verified main review / completed Jobs. |

## Supply

| KPI                           | Formula / denominator                                      |
| ----------------------------- | ---------------------------------------------------------- |
| `public_approved_craftsmen`   | Distinct currently public/approved `craftsman_profile_id`. |
| `invitation_response_rate`    | ENGAGED invitations / sent invitations.                    |
| `quotes_per_engaged_provider` | Submitted Quotes / ENGAGED invitation responses.           |
| `wins_per_quote`              | Won Jobs / submitted Quotes.                               |

## Search and liquidity

| KPI                          | Formula / denominator                                                    |
| ---------------------------- | ------------------------------------------------------------------------ |
| `searches`                   | Distinct successfully completed authoritative searches.                  |
| `zero_result_search_rate`    | ZERO-result searches / completed searches.                               |
| `search_profile_open_rate`   | Searches followed by an actual result-profile open / completed searches. |
| `mean_candidates_per_search` | Sum of bounded eligible candidate counts / completed searches.           |

Search facts store taxonomy/region IDs and bounded result counts only. A profile
open is a content-free fact keyed by `search_id`; it is not business acceptance.

## Speed

For each transition below, both the median (p50) and nearest-rank p90 are
reported over non-negative server-time durations. The denominator is the count
of entities that reached both endpoints; an empty denominator produces `null`.

- request submission → first ENGAGED provider;
- request submission → first submitted Quote;
- first submitted Quote → Job confirmation;
- Job confirmation → actual start;
- actual start → authoritative completion.

## Quality/process and review

| KPI                                     | Formula / denominator                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `completion_attempts_per_completed_job` | Completion attempts / completed Jobs.                                                           |
| `change_order_job_rate`                 | Confirmed Jobs with at least one Change order / confirmed Jobs.                                 |
| `dispute_job_rate`                      | Confirmed Jobs with at least one dispute / confirmed Jobs.                                      |
| `report_job_rate`                       | Confirmed Jobs with at least one Job-linked review/response/evaluation report / confirmed Jobs. |
| `completion_to_review_rate`             | Completed Jobs with a verified main review / completed Jobs.                                    |

Change-order, dispute, report and completion-attempt metrics are descriptive
process context only. They are not ranking or automatic reputation signals.
