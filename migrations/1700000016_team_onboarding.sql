-- Up Migration

ALTER TABLE users ADD COLUMN team_onboarding_completed_at TIMESTAMPTZ;

UPDATE users
SET team_onboarding_completed_at = now()
WHERE role = 'admin' OR team_id IS NOT NULL;

ALTER TABLE invites ADD COLUMN team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE invites DROP COLUMN IF EXISTS team_id;
ALTER TABLE users DROP COLUMN IF EXISTS team_onboarding_completed_at;
