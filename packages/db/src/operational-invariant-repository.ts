import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;

export const OPERATIONAL_INVARIANT_NAMES = Object.freeze([
  "JOB_REQUEST_SINGLE_JOB",
  "JOB_ACCEPTANCE_PROVENANCE",
  "APPROVED_CHANGE_ORDER_PROVENANCE",
  "COMPLETED_JOB_CONTEXT",
  "SEALED_REVIEW_PUBLICATION",
  "PUBLIC_PROJECTION_PRIVATE_FIELDS",
  "PRIVILEGED_JOB_CORRECTION_AUDIT",
] as const);
export type OperationalInvariantName =
  (typeof OPERATIONAL_INVARIANT_NAMES)[number];

export interface OperationalInvariantResult {
  readonly name: OperationalInvariantName;
  readonly violationCount: number;
}

export interface OperationalInvariantRepository {
  check(): Promise<readonly OperationalInvariantResult[]>;
}

interface InvariantRow {
  readonly name: string;
  readonly violationCount: number;
}

/** Read-only D29 checks. Findings are reported; commercial history is never repaired here. */
export function createOperationalInvariantRepository(
  sql: RootSql,
): OperationalInvariantRepository {
  return Object.freeze({
    async check() {
      const rows = await sql<InvariantRow[]>`
        SELECT 'JOB_REQUEST_SINGLE_JOB' AS name, count(*)::integer AS "violationCount"
        FROM (
          SELECT job_request_id FROM jobs GROUP BY job_request_id HAVING count(*) <> 1
        ) duplicate_job
        UNION ALL
        SELECT 'JOB_ACCEPTANCE_PROVENANCE', count(*)::integer
        FROM jobs job
        LEFT JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
        LEFT JOIN job_acceptance_events accepted ON accepted.job_id = job.id
        WHERE snapshot.job_id IS NULL OR accepted.job_id IS NULL
        UNION ALL
        SELECT 'APPROVED_CHANGE_ORDER_PROVENANCE', count(*)::integer
        FROM current_change_order_revision_states state
        JOIN change_order_revisions revision ON revision.id = state.revision_id
        JOIN change_orders change_order ON change_order.id = revision.change_order_id
        LEFT JOIN job_agreement_snapshots snapshot ON snapshot.job_id = change_order.job_id
        WHERE state.state = 'APPROVED' AND (
          snapshot.job_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM change_order_revision_actions action
            WHERE action.revision_id = revision.id AND action.action = 'APPROVE'
          )
        )
        UNION ALL
        SELECT 'COMPLETED_JOB_CONTEXT', count(*)::integer
        FROM current_job_states state
        WHERE state.state = 'COMPLETED'
          AND NOT EXISTS (
            SELECT 1 FROM job_admin_completion_commands admin_completion
            WHERE admin_completion.job_id = state.job_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM job_completion_attempts attempt
            JOIN job_completion_decisions decision ON decision.attempt_id = attempt.id
              AND decision.kind = 'ACCEPT'
            WHERE attempt.job_id = state.job_id
          )
        UNION ALL
        SELECT 'SEALED_REVIEW_PUBLICATION', count(*)::integer
        FROM current_searchable_craftsman_trust_signals public_signal
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS expected_count
          FROM current_unlocked_provider_main_review_scores review
          WHERE review.craftsman_profile_id = public_signal.craftsman_profile_id
        ) unlocked ON true
        WHERE public_signal.review_count IS DISTINCT FROM coalesce(unlocked.expected_count, 0)
        UNION ALL
        SELECT 'PUBLIC_PROJECTION_PRIVATE_FIELDS', count(*)::integer
        FROM information_schema.columns column_definition
        WHERE column_definition.table_schema = current_schema()
          AND (
            column_definition.table_name LIKE 'current_public_%'
            OR column_definition.table_name LIKE 'current_searchable_%'
          )
          AND column_definition.column_name ~* '(^|_)(email|phone|contact|exact_address|address_line|street|latitude|longitude|coordinates)($|_)'
        UNION ALL
        SELECT 'PRIVILEGED_JOB_CORRECTION_AUDIT', count(*)::integer
        FROM (
          SELECT completion.command_id
          FROM job_admin_completion_commands completion
          LEFT JOIN audit_events audit ON audit.event_id = completion.audit_event_id
            AND audit.correlation_id = completion.command_id
            AND audit.action_type = 'admin.job.force_completed'
            AND audit.actor_user_id = completion.actor_user_id
            AND audit.target_type = 'JOB'
            AND audit.target_id = completion.job_id::text
          WHERE audit.event_id IS NULL
          UNION ALL
          SELECT cancellation.command_id
          FROM job_admin_cancellation_commands cancellation
          LEFT JOIN audit_events audit ON audit.event_id = cancellation.audit_event_id
            AND audit.correlation_id = cancellation.command_id
            AND audit.action_type = 'admin.job.force_cancelled'
            AND audit.actor_user_id = cancellation.actor_user_id
            AND audit.target_type = 'JOB'
            AND audit.target_id = cancellation.job_id::text
          WHERE audit.event_id IS NULL
        ) unaudited
      `;
      return validateRows(rows);
    },
  });
}

function validateRows(
  rows: readonly InvariantRow[],
): readonly OperationalInvariantResult[] {
  const byName = new Map(rows.map((row) => [row.name, row] as const));
  if (
    rows.length !== OPERATIONAL_INVARIANT_NAMES.length ||
    byName.size !== rows.length
  ) {
    throw new TypeError(
      "operational invariant query returned an incomplete result",
    );
  }
  return Object.freeze(
    OPERATIONAL_INVARIANT_NAMES.map((name) => {
      const row = byName.get(name);
      if (
        row === undefined ||
        !Number.isSafeInteger(row.violationCount) ||
        row.violationCount < 0
      ) {
        throw new TypeError(
          "operational invariant query returned an invalid count",
        );
      }
      return Object.freeze({ name, violationCount: row.violationCount });
    }),
  );
}
