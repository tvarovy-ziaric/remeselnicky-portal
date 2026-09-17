-- PostgreSQL enum values must be committed before a later migration uses them.
ALTER TYPE job_request_state ADD VALUE 'CONVERTED';
