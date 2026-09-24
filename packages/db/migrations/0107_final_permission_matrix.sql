-- R4-025 / D24 / D26: compose current moderation restrictions with every
-- user-authored R1-R4 command ingress. Existing records and read projections
-- remain available; only new mutations are denied. Appeals, authentication,
-- privacy requests and notification/security controls intentionally remain
-- outside this marketplace-command matrix.

CREATE FUNCTION moderation_user_scope_allows(
  actor_id uuid,
  requested_scope moderation_enforcement_scope
)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM current_moderation_user_restrictions restriction
    WHERE restriction.subject_user_id = actor_id
      AND restriction.enforcement_scope IN ('ACCOUNT', requested_scope)
  )
$$;

CREATE FUNCTION enforce_user_command_moderation_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE actor_id uuid;
DECLARE requested_scope moderation_enforcement_scope;
BEGIN
  IF TG_NARGS <> 2 THEN
    RAISE EXCEPTION 'moderation command guard requires actor column and scope';
  END IF;
  requested_scope := TG_ARGV[1]::moderation_enforcement_scope;
  actor_id := nullif(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
  -- Null actors are reserved for already-authorized system transitions such as
  -- expiry. Human commands always carry an actor and are evaluated here.
  IF actor_id IS NULL THEN RETURN NEW; END IF;
  IF NOT moderation_user_scope_allows(actor_id, requested_scope) THEN
    RAISE EXCEPTION 'active moderation restriction prohibits command'
      USING ERRCODE = '42501', DETAIL = requested_scope::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_media_upload_moderation_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE requested_scope moderation_enforcement_scope;
BEGIN
  requested_scope := CASE NEW.purpose
    WHEN 'PROFILE_IMAGE' THEN 'PUBLISHING'::moderation_enforcement_scope
    WHEN 'PORTFOLIO_IMAGE' THEN 'PUBLISHING'::moderation_enforcement_scope
    WHEN 'CREDENTIAL_DOCUMENT' THEN 'PUBLISHING'::moderation_enforcement_scope
    WHEN 'CREDENTIAL_IMAGE' THEN 'PUBLISHING'::moderation_enforcement_scope
    WHEN 'CHAT_IMAGE' THEN 'MESSAGING'::moderation_enforcement_scope
    WHEN 'CHAT_DOCUMENT' THEN 'MESSAGING'::moderation_enforcement_scope
    WHEN 'QUOTE_DOCUMENT' THEN 'QUOTING'::moderation_enforcement_scope
    ELSE 'ACCOUNT'::moderation_enforcement_scope
  END;
  IF NOT moderation_user_scope_allows(NEW.uploaded_by_user_id, requested_scope) THEN
    RAISE EXCEPTION 'active moderation restriction prohibits media upload'
      USING ERRCODE = '42501', DETAIL = requested_scope::text;
  END IF;
  RETURN NEW;
END;
$$;

-- Provider publication/profile authoring.
CREATE TRIGGER a00_moderation_scope_craftsman_profile_create
BEFORE INSERT ON craftsman_profiles FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('owner_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_craftsman_profession
BEFORE INSERT ON craftsman_profession_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_craftsman_specialization
BEFORE INSERT ON craftsman_specialization_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_craftsman_skill
BEFORE INSERT ON craftsman_skill_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_custom_skill_mapping
BEFORE INSERT ON craftsman_custom_skill_mapping_events FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_service_area
BEFORE INSERT ON craftsman_service_area_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_indicative_pricing
BEFORE INSERT ON indicative_pricing_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_experience
BEFORE INSERT ON craftsman_experience_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_availability
BEFORE INSERT ON craftsman_availability_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_portfolio_project
BEFORE INSERT ON portfolio_project_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_portfolio_photo
BEFORE INSERT ON portfolio_photo_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_portfolio_collaboration
BEFORE INSERT ON portfolio_collaboration_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_featured_project
BEFORE INSERT ON featured_project_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_portfolio_publication
BEFORE INSERT ON portfolio_project_publication_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_profile_publication
BEFORE INSERT ON craftsman_profile_publication_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');
CREATE TRIGGER a00_moderation_scope_credential_claim
BEFORE INSERT ON credential_claim_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'PUBLISHING');

-- Bilateral chat mutations. Read/archive/mute/report operations are deliberately
-- not classified as MESSAGING, so history and protective controls remain usable.
CREATE TRIGGER a00_moderation_scope_conversation_message
BEFORE INSERT ON conversation_message_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'MESSAGING');

-- Quote authoring, lifecycle, supporting documents and final acceptance.
CREATE TRIGGER a00_moderation_scope_quote_core
BEFORE INSERT ON quote_core_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'QUOTING');
CREATE TRIGGER a00_moderation_scope_quote_structured
BEFORE INSERT ON quote_structured_authoring_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'QUOTING');
CREATE TRIGGER a00_moderation_scope_quote_external_pdf
BEFORE INSERT ON quote_external_pdf_authoring_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'QUOTING');
CREATE TRIGGER a00_moderation_scope_quote_lifecycle
BEFORE INSERT ON quote_lifecycle_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'QUOTING');
CREATE TRIGGER a00_moderation_scope_quote_supporting_document
BEFORE INSERT ON quote_revision_supporting_documents FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('attached_by_user_id', 'QUOTING');
CREATE TRIGGER a00_moderation_scope_quote_supporting_document_removal
BEFORE INSERT ON quote_revision_supporting_document_removals FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('removed_by_user_id', 'QUOTING');
CREATE TRIGGER a00_moderation_scope_quote_acceptance
BEFORE INSERT ON jobs FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('accepted_by_user_id', 'QUOTING');

-- Review/evaluation creation and bounded author response revisions.
CREATE TRIGGER a00_moderation_scope_main_review
BEFORE INSERT ON job_main_review_events FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'REVIEWS');
CREATE TRIGGER a00_moderation_scope_context_review
BEFORE INSERT ON job_context_reviews FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('author_user_id', 'REVIEWS');
CREATE TRIGGER a00_moderation_scope_context_review_revision
BEFORE INSERT ON job_context_review_revisions FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'REVIEWS');
CREATE TRIGGER a00_moderation_scope_supervisor_evaluation
BEFORE INSERT ON job_supervisor_evaluations FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('evaluator_user_id', 'REVIEWS');
CREATE TRIGGER a00_moderation_scope_supervisor_evaluation_revision
BEFORE INSERT ON job_supervisor_evaluation_revisions FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'REVIEWS');
CREATE TRIGGER a00_moderation_scope_main_review_response
BEFORE INSERT ON job_main_review_responses FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('author_user_id', 'REVIEWS');
CREATE TRIGGER a00_moderation_scope_main_review_response_revision
BEFORE INSERT ON job_main_review_response_events FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'REVIEWS');

-- Remaining ordinary marketplace commands are guarded by ACCOUNT. This list is
-- explicit and reviewable; privileged admin commands and user appeal/privacy
-- rights are intentionally not inherited from a blanket table-name rule.
CREATE TRIGGER a00_moderation_scope_customer_profile_create
BEFORE INSERT ON customer_profiles FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('owner_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_customer_shortlist
BEFORE INSERT ON customer_shortlist_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_request
BEFORE INSERT ON job_request_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_request_active_edit
BEFORE INSERT ON job_request_active_edit_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_invitation
BEFORE INSERT ON job_invitation_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_conversation_state
BEFORE INSERT ON conversation_participant_state_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_conversation_report
BEFORE INSERT ON conversation_reports FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('reporter_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_location_clarification
BEFORE INSERT ON job_location_clarification_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_lifecycle
BEFORE INSERT ON job_lifecycle_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_crew_create
BEFORE INSERT ON crews FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('created_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_participant
BEFORE INSERT ON job_participants FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('invited_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_participant_event
BEFORE INSERT ON job_participant_events FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_work_group
BEFORE INSERT ON job_work_groups FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('created_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_work_group_assignment
BEFORE INSERT ON job_work_group_assignments FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('assigned_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_work_group_departure
BEFORE INSERT ON job_work_group_departure_events FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_participant_role
BEFORE INSERT ON job_participant_role_events FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_crew_membership_invitation
BEFORE INSERT ON crew_membership_invitations FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('invited_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_crew_membership_event
BEFORE INSERT ON crew_membership_events FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_participant_capability_claim
BEFORE INSERT ON job_participant_capability_claims FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('proposed_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_participant_capability_confirmation
BEFORE INSERT ON job_participant_capability_confirmations FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('confirmed_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_progress
BEFORE INSERT ON job_progress_updates FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('author_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_progress_ack
BEFORE INSERT ON job_progress_acknowledgements FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('customer_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_issue
BEFORE INSERT ON job_issues FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('author_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_issue_comment
BEFORE INSERT ON job_issue_comments FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('author_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_milestone
BEFORE INSERT ON job_milestones FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('created_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_milestone_event
BEFORE INSERT ON job_milestone_events FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_milestone_ack
BEFORE INSERT ON job_milestone_acknowledgements FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('customer_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_milestone_proposal
BEFORE INSERT ON job_milestone_proposals FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('customer_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_milestone_proposal_decision
BEFORE INSERT ON job_milestone_proposal_decisions FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_milestone_comment
BEFORE INSERT ON job_milestone_comments FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('author_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_milestone_media
BEFORE INSERT ON job_milestone_media FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('linked_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_change_order
BEFORE INSERT ON change_orders FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('created_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_change_order_revision
BEFORE INSERT ON change_order_revisions FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('authored_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_change_order_action
BEFORE INSERT ON change_order_revision_actions FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_change_order_pdf_reservation
BEFORE INSERT ON change_order_pdf_upload_reservations FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('provider_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_completion_attempt
BEFORE INSERT ON job_completion_attempts FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('requested_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_completion_decision
BEFORE INSERT ON job_completion_decisions FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_completion_proposal
BEFORE INSERT ON job_completion_proposals FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('customer_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_job_completion_proposal_decision
BEFORE INSERT ON job_completion_proposal_decisions FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('provider_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_participant_role_decision
BEFORE INSERT ON job_participant_role_decisions FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_dispute_case
BEFORE INSERT ON dispute_cases FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('opened_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_dispute_statement
BEFORE INSERT ON dispute_case_statements FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('author_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_dispute_evidence
BEFORE INSERT ON dispute_case_evidence FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('submitted_by_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_dispute_party_command
BEFORE INSERT ON dispute_case_party_commands FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('actor_user_id', 'ACCOUNT');
CREATE TRIGGER a00_moderation_scope_moderation_report
BEFORE INSERT ON moderation_reports FOR EACH ROW
EXECUTE FUNCTION enforce_user_command_moderation_scope('reporter_user_id', 'ACCOUNT');

CREATE TRIGGER a00_moderation_scope_media_upload
BEFORE INSERT ON media_assets FOR EACH ROW
EXECUTE FUNCTION enforce_media_upload_moderation_scope();

COMMENT ON FUNCTION moderation_user_scope_allows(uuid, moderation_enforcement_scope) IS
  'D24/D26 current-command admission: ACCOUNT overrides all marketplace scopes; historical reads and appeal/privacy controls are separate.';
COMMENT ON FUNCTION enforce_user_command_moderation_scope() IS
  'Explicit per-table defense-in-depth for user-authored R1-R4 mutation ingress.';
