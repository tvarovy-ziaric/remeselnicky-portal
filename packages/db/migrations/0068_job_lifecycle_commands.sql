-- The accepted Job identity and agreement remain immutable. These commands
-- are the only source of the derived execution state.
CREATE TYPE job_lifecycle_command_kind AS ENUM ('START', 'CANCEL');

CREATE TABLE job_lifecycle_commands (
  command_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_kind job_lifecycle_command_kind NOT NULL,
  expected_state job_state NOT NULL,
  actor_role text NOT NULL CHECK (
    actor_role IN ('CUSTOMER', 'PRIMARY_PROVIDER')
  ),
  reason text,
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, command_kind),
  CONSTRAINT job_lifecycle_command_shape CHECK (
    (command_kind = 'START' AND expected_state = 'CONFIRMED'
      AND actor_role = 'PRIMARY_PROVIDER' AND reason IS NULL)
    OR (command_kind = 'CANCEL'
      AND expected_state IN ('CONFIRMED', 'IN_PROGRESS')
      AND reason IS NOT NULL
      AND length(btrim(reason)) BETWEEN 8 AND 1000)
  )
);

CREATE VIEW current_job_states AS
SELECT job.id AS job_id,
  CASE
    WHEN cancelled.command_id IS NOT NULL THEN 'CANCELLED'::job_state
    WHEN started.command_id IS NOT NULL THEN 'IN_PROGRESS'::job_state
    ELSE 'CONFIRMED'::job_state
  END AS state,
  started.recorded_at AS started_at,
  started.actor_user_id AS started_by_user_id,
  cancelled.recorded_at AS cancelled_at,
  cancelled.actor_user_id AS cancelled_by_user_id,
  cancelled.actor_role AS cancellation_initiator_role,
  cancelled.reason AS cancellation_reason
FROM jobs job
LEFT JOIN job_lifecycle_commands started
  ON started.job_id = job.id AND started.command_kind = 'START'
LEFT JOIN job_lifecycle_commands cancelled
  ON cancelled.job_id = job.id AND cancelled.command_kind = 'CANCEL';

CREATE INDEX job_lifecycle_commands_job_time_idx
  ON job_lifecycle_commands (job_id, recorded_at, command_id);

CREATE FUNCTION validate_job_lifecycle_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_state job_state;
  actual_role text;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmed Job required';
  END IF;
  PERFORM 1 FROM users WHERE id = NEW.actor_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials
    WHERE user_id = NEW.actor_user_id FOR SHARE;
  SELECT CASE
      WHEN NEW.actor_role = 'CUSTOMER'
        AND customer.owner_user_id = actor.id THEN 'CUSTOMER'
      WHEN NEW.actor_role = 'PRIMARY_PROVIDER'
        AND provider.owner_user_id = actor.id THEN 'PRIMARY_PROVIDER'
      ELSE NULL
    END, state.state
    INTO actual_role, actual_state
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider
    ON provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = NEW.actor_user_id
  JOIN auth_credentials credentials ON credentials.user_id = actor.id
  JOIN current_job_states state ON state.job_id = job.id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  WHERE job.id = NEW.job_id
    AND actor.account_state = 'ACTIVE'
    AND credentials.email_verified_at IS NOT NULL
    AND credentials.phone_verified_at IS NOT NULL;
  IF actual_role IS NULL OR actual_role <> NEW.actor_role THEN
    RAISE EXCEPTION 'primary Job party required';
  END IF;
  IF actual_state IS DISTINCT FROM NEW.expected_state THEN
    RAISE EXCEPTION 'stale Job execution state';
  END IF;
  IF NEW.command_kind = 'START' AND actual_role <> 'PRIMARY_PROVIDER' THEN
    RAISE EXCEPTION 'primary provider must start work';
  END IF;
  IF NEW.command_kind = 'CANCEL'
      AND actual_state NOT IN ('CONFIRMED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'Job cannot be cancelled in this state';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_lifecycle_command_validate
BEFORE INSERT ON job_lifecycle_commands
FOR EACH ROW EXECUTE FUNCTION validate_job_lifecycle_command();

CREATE FUNCTION reject_job_lifecycle_command_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job lifecycle commands are immutable';
END;
$$;

CREATE TRIGGER job_lifecycle_command_immutable
BEFORE UPDATE OR DELETE ON job_lifecycle_commands
FOR EACH ROW EXECUTE FUNCTION reject_job_lifecycle_command_mutation();

CREATE FUNCTION notify_job_lifecycle_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recipient_user_id uuid;
  state_revision integer;
BEGIN
  SELECT CASE WHEN NEW.actor_role = 'CUSTOMER'
      THEN provider.owner_user_id ELSE customer.owner_user_id END
    INTO recipient_user_id
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider
    ON provider.id = job.primary_craftsman_profile_id
  WHERE job.id = NEW.job_id;
  SELECT count(*)::integer INTO state_revision
  FROM job_lifecycle_commands WHERE job_id = NEW.job_id;
  IF recipient_user_id IS NULL OR state_revision NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'Job lifecycle notification recipient missing';
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    'job.lifecycle.' || NEW.command_id::text,
    CASE WHEN NEW.command_kind = 'START'
      THEN 'job.started' ELSE 'job.cancelled' END,
    NEW.recorded_at,
    'JOB', NEW.job_id::text,
    jsonb_build_object(
      'recipient_user_id', recipient_user_id::text,
      'job_state_revision', state_revision
    ),
    CASE WHEN NEW.command_kind = 'START'
      THEN 'job.start' ELSE 'job.cancel' END,
    NEW.command_id::text, NEW.recorded_at
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER job_lifecycle_command_notify
AFTER INSERT ON job_lifecycle_commands
FOR EACH ROW EXECUTE FUNCTION notify_job_lifecycle_command();

CREATE VIEW job_chronological_system_events AS
SELECT event.event_id, event.job_id, event.event_type,
  event.occurred_at, event.event_order::integer AS event_order,
  NULL::text AS actor_role, NULL::text AS reason
FROM job_system_timeline_events event
UNION ALL
SELECT command.command_id AS event_id, command.job_id,
  CASE WHEN command.command_kind = 'START'
    THEN 'JOB_STARTED' ELSE 'JOB_CANCELLED' END AS event_type,
  command.recorded_at AS occurred_at,
  CASE WHEN command.command_kind = 'START' THEN 3 ELSE 4 END AS event_order,
  command.actor_role, command.reason
FROM job_lifecycle_commands command;

COMMENT ON TABLE job_lifecycle_commands IS
  'Immutable authorized Job start/cancellation commands; current state derives from this history without changing the accepted agreement.';
