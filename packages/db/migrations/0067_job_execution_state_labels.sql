-- Enum additions must commit before a subsequent migration can use them.
ALTER TYPE job_state ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
ALTER TYPE job_state ADD VALUE IF NOT EXISTS 'CANCELLED';
