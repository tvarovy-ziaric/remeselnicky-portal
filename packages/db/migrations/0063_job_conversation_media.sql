-- A Job inherits only the winning conversation's private, READY attachments.
-- This is a live chronology: later messages in that conversation appear without
-- copying binaries or rewriting the immutable acceptance agreement snapshot.
CREATE VIEW job_conversation_media AS
SELECT job.id AS job_id,
  job.winning_conversation_id AS conversation_id,
  candidate.source_message_id,
  message.sequence AS source_message_sequence,
  candidate.media_asset_id,
  candidate.uploaded_by_user_id,
  candidate.media_kind,
  asset.purpose AS media_purpose,
  asset.created_at AS uploaded_at,
  asset.captured_at,
  candidate.chronological_at
FROM jobs job
JOIN conversation_job_media_candidates candidate
  ON candidate.conversation_id = job.winning_conversation_id
JOIN conversation_timeline_entries message
  ON message.id = candidate.source_message_id
  AND message.conversation_id = job.winning_conversation_id
JOIN media_assets asset ON asset.id = candidate.media_asset_id
WHERE job.initial_state = 'CONFIRMED';

COMMENT ON VIEW job_conversation_media IS
  'Private Job-level chronological attachment projection for the winning conversation only. Callers must authorize the current Job participant before reading this view or issuing a private-media grant; it is not an accepted-Quote attachment snapshot.';
