ALTER TABLE conversation_message_commands
  ADD COLUMN policy_stage text NOT NULL DEFAULT 'LEGACY_PRE_CONFIRM',
  ADD COLUMN policy_version integer NOT NULL DEFAULT 0;

ALTER TABLE conversation_message_commands
  ALTER COLUMN policy_stage DROP DEFAULT,
  ALTER COLUMN policy_version DROP DEFAULT,
  ADD CONSTRAINT conversation_message_commands_policy_stage CHECK (
    policy_stage IN ('LEGACY_PRE_CONFIRM', 'PRE_CONFIRM', 'POST_CONFIRM')
  ),
  ADD CONSTRAINT conversation_message_commands_policy_version CHECK (
    (policy_stage = 'LEGACY_PRE_CONFIRM' AND policy_version = 0)
    OR (policy_stage IN ('PRE_CONFIRM', 'POST_CONFIRM') AND policy_version > 0)
  );

COMMENT ON COLUMN conversation_message_commands.policy_stage IS
  'Server-authored stage used for the accepted message policy decision. LEGACY_PRE_CONFIRM identifies rows accepted before policy version 1.';
COMMENT ON COLUMN conversation_message_commands.policy_version IS
  'Server-authored policy version. Version 0 is reserved for legacy accepted rows and does not claim evaluation by the current detector.';

-- Until the confirmed-Job authority exists, every real conversation remains
-- PRE_CONFIRM. The future confirmation migration must replace this function
-- with an authoritative Job-state join; unknown/missing state stays NULL and
-- therefore fails closed in the command guard.
CREATE FUNCTION conversation_message_policy_stage(target_conversation_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM conversations conversation
    WHERE conversation.id = target_conversation_id
  ) THEN 'PRE_CONFIRM'::text ELSE NULL::text END;
$$;

CREATE FUNCTION conversation_message_violates_preconfirm_policy(candidate text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  normalized text := lower(
    replace(replace(replace(replace(normalize(candidate, NFKC),
      chr(8203), ''), chr(8204), ''), chr(8205), ''), chr(8288), '')
  );
BEGIN
  RETURN
    -- Email, including common obvious separator obfuscation.
    normalized ~ '[[:alnum:]_%+.-]{1,64}[[:space:]]*@[[:space:]]*[[:alnum:]-]+([[:space:]]*\.[[:space:]]*[[:alnum:]-]+)+'
    OR normalized ~ '[[:alnum:]_%+.-]{1,64}[[:space:]]*(\(at\)|\[at\]|zavin[aá]č)[[:space:]]*[[:alnum:]-]+([[:space:]]*(\.|\(dot\)|\[dot\]|bodka)[[:space:]]*[[:alnum:]-]+)+'
    -- Phone-like digit sequences and labelled shorter obvious contacts.
    OR normalized ~ '(^|[^0-9])(\+|00)?[0-9]([[:space:]()/-]*[0-9]){6,}([^0-9]|$)'
    OR normalized ~ '(^|[^[:alnum:]_])(telef[oó]n|tel\.?|mobil|volaj|zavolaj|whatsapp|viber)([^[:alnum:]_]|$)[^0-9\n]{0,20}[0-9]([[:space:]()./-]*[0-9]){4,}'
    -- Direct contact schemes and exact contact-service hosts only.
    OR normalized ~ '(^|[^[:alnum:]_])(mailto|tel)[[:space:]]*:'
    OR normalized ~ 'https?://(www\.)?wa\.me([/?#[:space:]]|$)'
    OR normalized ~ 'https?://(www\.)?(m\.me|t\.me|signal\.me)/[[:alnum:]_.%+~@-]+'
    OR (
      normalized ~ 'https?://(www\.)?instagram\.com/[[:alnum:]_.-]{2,}([/?#[:space:]]|$)'
      AND normalized !~ 'https?://(www\.)?instagram\.com/(p|reel|explore|business)/'
    )
    OR (
      normalized ~ 'https?://(www\.)?facebook\.com/(profile\.php\?id=[0-9]+|[[:alnum:]_.-]{2,})([/?#[:space:]]|$)'
      AND normalized !~ 'https?://(www\.)?facebook\.com/(business|help|groups|watch|marketplace)/'
    )
    OR normalized ~ '(^|[^[:alnum:]_])(instagram|insta|ig|facebook|fb|messenger|telegram|signal|whatsapp|viber|tiktok)([^[:alnum:]_]|$)[^\n]{0,30}(@[[:alnum:]_.-]{2,}|(profil|profile|meno|username|nick)[[:space:]]*[:=-]?[[:space:]]*[[:alnum:]_.-]{2,}|[:=-][[:space:]]*[[:alnum:]_.-]{2,})'
    -- Postal/address disclosures. Slash fractions alone are intentionally safe.
    OR normalized ~ '(^|[^[:alnum:]_])(psč|psc)([^[:alnum:]_]|$)[^0-9\n]{0,12}[0-9]{3}[[:space:]]?[0-9]{2}([^0-9]|$)'
    OR normalized ~ '(^|[^0-9])[0-9]{3}[[:space:]][0-9]{2}([^0-9]|$)'
    OR normalized ~ '(^|[^[:alnum:]_])(adresa|ulica|námestie|namestie|trieda|číslo[[:space:]]+(domu|bytu)|cislo[[:space:]]+(domu|bytu)|súpisné[[:space:]]+číslo|supisne[[:space:]]+cislo|ul\.|nám\.|nam\.)([^[:alnum:]_]|$)[^\n]{0,80}[0-9]{1,5}([[:space:]]*/[[:space:]]*[0-9]{1,5})?'
    -- Decimal coordinate pairs and obvious DMS coordinates.
    OR normalized ~ '(^|[^0-9])[-+]?[0-9]{1,3}[.,][0-9]{4,}[[:space:]]*[,;/][[:space:]]*[-+]?[0-9]{1,3}[.,][0-9]{4,}([^0-9]|$)'
    OR normalized ~ '[0-9]{1,3}[[:space:]]*°[[:space:]]*[0-9]{1,2}([.,][0-9]+)?[[:space:]]*[′'']([[:space:]]*[0-9]{1,2}([.,][0-9]+)?[[:space:]]*[″"])?[[:space:]]*[nsew]';
END;
$$;

CREATE OR REPLACE FUNCTION validate_conversation_message_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_invitation_id uuid;
  resolved_policy_stage text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.command_id::text, 45001)
  );
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'writable participant conversation required';
  END IF;
  SELECT invitation_id INTO source_invitation_id
  FROM conversations WHERE id = NEW.conversation_id;
  IF source_invitation_id IS NULL THEN
    RAISE EXCEPTION 'writable participant conversation required';
  END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = NEW.conversation_id FOR UPDATE;
  IF NOT FOUND OR NOT conversation_participant_is_active(
      NEW.conversation_id, NEW.actor_user_id, true
    ) THEN
    RAISE EXCEPTION 'writable participant conversation required';
  END IF;
  IF NEW.reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation_timeline_entries reply
    WHERE reply.id = NEW.reply_to_message_id
      AND reply.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'reply message must belong to conversation';
  END IF;

  resolved_policy_stage := conversation_message_policy_stage(
    NEW.conversation_id
  );
  IF resolved_policy_stage IS NULL
      OR resolved_policy_stage NOT IN ('PRE_CONFIRM', 'POST_CONFIRM') THEN
    RAISE EXCEPTION 'conversation message policy stage unavailable';
  END IF;
  NEW.policy_stage := resolved_policy_stage;
  NEW.policy_version := 1;
  IF resolved_policy_stage = 'PRE_CONFIRM'
      AND conversation_message_violates_preconfirm_policy(NEW.body) THEN
    RAISE EXCEPTION 'message blocked by pre-confirmation contact policy';
  END IF;

  NEW.resulting_message_id := gen_random_uuid();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
