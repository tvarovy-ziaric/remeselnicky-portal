-- R3-007 follow-up: authentication verification belongs to auth_credentials,
-- not to the domain users row. Keep the invitation command guard authoritative
-- at the database boundary while reading the canonical verification source.
CREATE OR REPLACE FUNCTION validate_job_invitation_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  identity job_invitations%ROWTYPE;
  current_revision job_invitation_revisions%ROWTYPE;
  customer_owner uuid;
  craftsman_owner uuid;
  actor_state user_account_state;
  actor_email_verified timestamptz;
  actor_phone_verified timestamptz;
  kind text := NEW.command_kind::text;
BEGIN
  SELECT * INTO identity FROM job_invitations
  WHERE id = NEW.invitation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation identity required'; END IF;
  SELECT * INTO current_revision FROM job_invitation_revisions
  WHERE invitation_id = NEW.invitation_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF kind IN ('EXPIRE', 'REQUEST_CLOSED', 'NOT_SELECT') THEN
    IF NOT NEW.system_initiated OR NEW.actor_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'system invitation command required';
    END IF;
  ELSE
    SELECT owner_user_id INTO customer_owner FROM customer_profiles
    WHERE id = identity.customer_profile_id FOR UPDATE;
    SELECT owner_user_id INTO craftsman_owner FROM craftsman_profiles
    WHERE id = identity.craftsman_profile_id FOR UPDATE;
    SELECT actor.account_state,
      credential.email_verified_at, credential.phone_verified_at
      INTO actor_state, actor_email_verified, actor_phone_verified
    FROM users actor
    JOIN auth_credentials credential ON credential.user_id = actor.id
    WHERE actor.id = NEW.actor_user_id
    FOR UPDATE OF actor, credential;
    IF NOT FOUND OR actor_state <> 'ACTIVE'
       OR actor_email_verified IS NULL OR actor_phone_verified IS NULL THEN
      RAISE EXCEPTION 'active verified invitation actor required';
    END IF;
    IF kind IN ('SEND', 'CUSTOMER_WITHDRAW', 'CUSTOMER_STOP')
       AND NEW.actor_user_id <> customer_owner THEN
      RAISE EXCEPTION 'owning customer actor required';
    END IF;
    IF kind IN ('ENGAGE', 'DECLINE', 'CRAFTSMAN_WITHDRAW')
       AND NEW.actor_user_id <> craftsman_owner THEN
      RAISE EXCEPTION 'invited craftsman actor required';
    END IF;
  END IF;

  IF kind = 'SEND' THEN
    IF current_revision.invitation_id IS NOT NULL
       OR NEW.expected_revision <> 0 OR NEW.target_state <> 'PENDING' THEN
      RAISE EXCEPTION 'invitation send must initialize pending state';
    END IF;
  ELSIF current_revision.invitation_id IS NULL
      OR current_revision.revision <> NEW.expected_revision THEN
    RAISE EXCEPTION 'invitation command is stale';
  ELSIF kind = 'ENGAGE' AND NOT (
      current_revision.state = 'PENDING' AND NEW.target_state = 'ENGAGED'
    ) THEN RAISE EXCEPTION 'engagement transition is invalid';
  ELSIF kind = 'DECLINE' AND NOT (
      current_revision.state = 'PENDING' AND NEW.target_state = 'DECLINED'
    ) THEN RAISE EXCEPTION 'decline transition is invalid';
  ELSIF kind = 'CUSTOMER_WITHDRAW' AND NOT (
      current_revision.state = 'PENDING' AND NEW.target_state = 'WITHDRAWN'
    ) THEN RAISE EXCEPTION 'withdraw transition is invalid';
  ELSIF kind = 'CUSTOMER_STOP' AND NOT (
      current_revision.state = 'ENGAGED' AND NEW.target_state = 'NOT_SELECTED'
    ) THEN RAISE EXCEPTION 'stop transition is invalid';
  ELSIF kind = 'CRAFTSMAN_WITHDRAW' AND NOT (
      current_revision.state = 'ENGAGED' AND NEW.target_state = 'WITHDRAWN'
    ) THEN RAISE EXCEPTION 'craftsman withdrawal transition is invalid';
  ELSIF kind = 'EXPIRE' AND NOT (
      current_revision.state = 'PENDING' AND NEW.target_state = 'EXPIRED'
      AND current_revision.expires_at <= clock_timestamp()
    ) THEN RAISE EXCEPTION 'invitation expiry transition is invalid';
  ELSIF kind = 'REQUEST_CLOSED' AND NOT (
      current_revision.state IN ('PENDING', 'ENGAGED')
      AND NEW.target_state = 'WITHDRAWN'
    ) THEN RAISE EXCEPTION 'request closure transition is invalid';
  ELSIF kind = 'NOT_SELECT' AND NOT (
      current_revision.state IN ('PENDING', 'ENGAGED')
      AND NEW.target_state = 'NOT_SELECTED'
    ) THEN RAISE EXCEPTION 'not-selected transition is invalid';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
