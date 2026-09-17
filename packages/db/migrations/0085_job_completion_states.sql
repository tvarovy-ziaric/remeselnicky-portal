-- PostgreSQL requires a transaction boundary before new enum values are used.
ALTER TYPE job_state ADD VALUE 'COMPLETION_REQUESTED';
ALTER TYPE job_state ADD VALUE 'COMPLETED';
