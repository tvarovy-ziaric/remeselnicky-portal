-- PostgreSQL requires new enum values to be committed before later migrations
-- may safely use them in functions, constraints and data writes.
ALTER TYPE dispute_case_transition_action ADD VALUE 'START_REVIEW';
ALTER TYPE dispute_case_transition_action ADD VALUE 'REQUEST_INFORMATION';
ALTER TYPE dispute_case_transition_action ADD VALUE 'RECORD_OUTCOME';
ALTER TYPE dispute_case_transition_action ADD VALUE 'CLOSE';
ALTER TYPE dispute_case_transition_action ADD VALUE 'REOPEN';
