-- Cleanup of duplicate / orphaned agent rows. Idempotent: safe to run repeatedly.
--  1. Revokes live OAuth grants of client 'exponential-agent' that belong to no PC (agent_id is null).
--  2. For PCs of one user with the same name (lower(trim(name)), non-empty) keeps the one with the latest
--     last_seen_at (nulls last) and removes the rest: revokes their grants, deletes their api_tokens, deletes the agents row.
-- No tombstones are written (these are replacements, not removals).
BEGIN;

UPDATE oauth_grants SET revoked_at = now()
WHERE client_id = 'exponential-agent' AND agent_id IS NULL AND revoked_at IS NULL;

CREATE TEMP TABLE dup_agents ON COMMIT DROP AS
SELECT id FROM (
  SELECT id, row_number() OVER (PARTITION BY user_id, lower(trim(name)) ORDER BY last_seen_at DESC NULLS LAST, id) AS rn
  FROM agents WHERE trim(name) <> ''
) x WHERE rn > 1;

UPDATE oauth_grants SET revoked_at = now() WHERE agent_id IN (SELECT id FROM dup_agents) AND revoked_at IS NULL;
DELETE FROM api_tokens WHERE agent_id IN (SELECT id FROM dup_agents);
DELETE FROM agents WHERE id IN (SELECT id FROM dup_agents);

COMMIT;
