-- Only accepted participation and its later departure are Job-wide timeline
-- facts. Pending and declined invitations stay private to the provider/invitee.
CREATE OR REPLACE VIEW job_chronological_system_events AS
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
FROM job_lifecycle_commands command
UNION ALL
SELECT event.event_id, participant.job_id,
  CASE event.event_kind
    WHEN 'ACCEPT' THEN 'PARTICIPANT_JOINED'
    WHEN 'LEAVE' THEN 'PARTICIPANT_LEFT'
    ELSE 'PARTICIPANT_REMOVED'
  END AS event_type,
  event.recorded_at AS occurred_at,
  CASE event.event_kind
    WHEN 'ACCEPT' THEN 5
    WHEN 'LEAVE' THEN 6
    ELSE 7
  END AS event_order,
  CASE WHEN event.event_kind = 'REMOVE'
    THEN 'PRIMARY_PROVIDER' ELSE 'PARTICIPANT' END AS actor_role,
  NULL::text AS reason
FROM job_participant_events event
JOIN job_participants participant ON participant.id = event.participant_id
WHERE event.event_kind IN ('ACCEPT', 'LEAVE', 'REMOVE');
