-- A job-specific claim is not verified capability evidence until the other
-- party confirms it. Neither table changes profile-level proficiency.
CREATE TYPE job_participant_capability_kind AS ENUM (
  'PROFESSION', 'CANONICAL_SKILL', 'CUSTOM_SKILL'
);

CREATE TABLE job_participant_capability_claims (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES job_participants(id) ON DELETE RESTRICT,
  kind job_participant_capability_kind NOT NULL,
  profession_taxonomy_release_id uuid,
  profession_code text,
  skill_catalog_release_id uuid,
  skill_code text,
  custom_skill_text text,
  proposed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (profession_taxonomy_release_id, profession_code)
    REFERENCES taxonomy_professions(release_id, profession_code) ON DELETE RESTRICT,
  FOREIGN KEY (skill_catalog_release_id, skill_code)
    REFERENCES skill_catalog_skills(release_id, skill_code) ON DELETE RESTRICT,
  CONSTRAINT job_participant_capability_identity CHECK (
    (kind = 'PROFESSION' AND profession_taxonomy_release_id IS NOT NULL
      AND profession_code IS NOT NULL AND skill_catalog_release_id IS NULL
      AND skill_code IS NULL AND custom_skill_text IS NULL)
    OR (kind = 'CANONICAL_SKILL' AND profession_taxonomy_release_id IS NULL
      AND profession_code IS NULL AND skill_catalog_release_id IS NOT NULL
      AND skill_code IS NOT NULL AND custom_skill_text IS NULL)
    OR (kind = 'CUSTOM_SKILL' AND profession_taxonomy_release_id IS NULL
      AND profession_code IS NULL AND skill_catalog_release_id IS NULL
      AND skill_code IS NULL AND custom_skill_text IS NOT NULL
      AND custom_skill_text = btrim(custom_skill_text)
      AND length(custom_skill_text) BETWEEN 2 AND 160
      AND craftsman_capability_public_text_safe(custom_skill_text))
  )
);
CREATE UNIQUE INDEX job_participant_capability_one_profession
  ON job_participant_capability_claims
    (participant_id, profession_code)
  WHERE kind = 'PROFESSION';
CREATE UNIQUE INDEX job_participant_capability_one_canonical_skill
  ON job_participant_capability_claims
    (participant_id, skill_code)
  WHERE kind = 'CANONICAL_SKILL';
CREATE UNIQUE INDEX job_participant_capability_one_custom_skill
  ON job_participant_capability_claims (participant_id, lower(custom_skill_text))
  WHERE kind = 'CUSTOM_SKILL';
CREATE INDEX job_participant_capability_time_idx
  ON job_participant_capability_claims (participant_id, proposed_at DESC, id DESC);

CREATE TABLE job_participant_capability_confirmations (
  event_id uuid PRIMARY KEY,
  claim_id uuid NOT NULL UNIQUE
    REFERENCES job_participant_capability_claims(id) ON DELETE RESTRICT,
  confirmed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION validate_job_participant_capability_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid;
BEGIN
  SELECT job_id INTO target_job_id FROM job_participants WHERE id = NEW.participant_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'Job participant required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM 1 FROM job_participants WHERE id = NEW.participant_id FOR UPDATE;
  PERFORM 1 FROM current_job_participants participant
  JOIN jobs job ON job.id = participant.job_id
  JOIN current_job_states state ON state.job_id = job.id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN craftsman_profiles target ON target.id = participant.craftsman_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = NEW.proposed_by_user_id
  WHERE participant.id = NEW.participant_id
    AND participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
    AND actor.account_state = 'ACTIVE'
    AND target.owner_user_id <> provider.owner_user_id
    AND actor.id IN (target.owner_user_id, provider.owner_user_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'active accepted Job parties required'; END IF;
  IF NEW.kind = 'PROFESSION' AND NOT EXISTS (
    SELECT 1 FROM taxonomy_professions profession
    WHERE profession.release_id = NEW.profession_taxonomy_release_id
      AND profession.profession_code = NEW.profession_code
      AND profession.state = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'active canonical profession required'; END IF;
  IF NEW.kind = 'CANONICAL_SKILL' AND NOT EXISTS (
    SELECT 1 FROM skill_catalog_skills skill
    WHERE skill.release_id = NEW.skill_catalog_release_id
      AND skill.skill_code = NEW.skill_code AND skill.state = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'active canonical skill required'; END IF;
  NEW.proposed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_participant_capability_claim_validate
BEFORE INSERT ON job_participant_capability_claims
FOR EACH ROW EXECUTE FUNCTION validate_job_participant_capability_claim();

CREATE FUNCTION validate_job_participant_capability_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid;
BEGIN
  SELECT participant.job_id INTO target_job_id
  FROM job_participant_capability_claims claim
  JOIN job_participants participant ON participant.id = claim.participant_id
  WHERE claim.id = NEW.claim_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'Job capability claim required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM 1 FROM job_participant_capability_claims WHERE id = NEW.claim_id FOR UPDATE;
  PERFORM 1 FROM job_participant_capability_claims claim
  JOIN current_job_participants participant ON participant.id = claim.participant_id
  JOIN jobs job ON job.id = participant.job_id
  JOIN current_job_states state ON state.job_id = job.id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN craftsman_profiles target ON target.id = participant.craftsman_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = NEW.confirmed_by_user_id
  WHERE claim.id = NEW.claim_id
    AND participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
    AND actor.account_state = 'ACTIVE'
    AND ((claim.proposed_by_user_id = provider.owner_user_id
      AND actor.id = target.owner_user_id)
      OR (claim.proposed_by_user_id = target.owner_user_id
        AND actor.id <> target.owner_user_id
        AND (actor.id = provider.owner_user_id OR EXISTS (
          SELECT 1 FROM job_participant_role_intervals role_interval
          JOIN current_job_participants responsible
            ON responsible.id = role_interval.participant_id
          JOIN craftsman_profiles responsible_profile
            ON responsible_profile.id = responsible.craftsman_profile_id
          WHERE responsible.job_id = job.id
            AND responsible_profile.owner_user_id = actor.id
            AND role_interval.active
            AND role_interval.role IN ('LEAD', 'SITE_MANAGER')
        ))));
  IF NOT FOUND THEN RAISE EXCEPTION 'opposite active Job party required'; END IF;
  NEW.confirmed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_participant_capability_confirmation_validate
BEFORE INSERT ON job_participant_capability_confirmations
FOR EACH ROW EXECUTE FUNCTION validate_job_participant_capability_confirmation();

CREATE FUNCTION reject_job_participant_capability_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Job participant capability evidence is immutable'; END;
$$;
CREATE TRIGGER job_participant_capability_claim_immutable
BEFORE UPDATE OR DELETE ON job_participant_capability_claims
FOR EACH ROW EXECUTE FUNCTION reject_job_participant_capability_mutation();
CREATE TRIGGER job_participant_capability_confirmation_immutable
BEFORE UPDATE OR DELETE ON job_participant_capability_confirmations
FOR EACH ROW EXECUTE FUNCTION reject_job_participant_capability_mutation();

CREATE VIEW confirmed_job_participant_capability_evidence AS
SELECT claim.id AS claim_id, claim.participant_id, claim.kind,
  claim.profession_taxonomy_release_id, claim.profession_code,
  claim.skill_catalog_release_id, claim.skill_code, claim.custom_skill_text,
  claim.proposed_by_user_id, claim.proposed_at,
  confirmation.confirmed_by_user_id, confirmation.confirmed_at
FROM job_participant_capability_claims claim
JOIN job_participant_capability_confirmations confirmation
  ON confirmation.claim_id = claim.id
JOIN current_job_participants participant ON participant.id = claim.participant_id
WHERE participant.verified_participation;
COMMENT ON VIEW confirmed_job_participant_capability_evidence IS
  'Bilateral job-specific evidence, not profile proficiency or proof of Job completion; authorized callers must scope reads.';
