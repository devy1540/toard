-- Up Migration

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE user_team_assignments
  DROP CONSTRAINT IF EXISTS user_team_assignments_user_id_effective_from_key,
  DROP CONSTRAINT IF EXISTS user_department_assignments_user_id_effective_from_key;

ALTER TABLE user_team_assignments
  ALTER COLUMN effective_from TYPE TIMESTAMPTZ
    USING effective_from::timestamp AT TIME ZONE 'UTC',
  ALTER COLUMN effective_to TYPE TIMESTAMPTZ
    USING effective_to::timestamp AT TIME ZONE 'UTC';

ALTER TABLE user_team_assignments
  ADD COLUMN assignment_kind TEXT,
  ADD COLUMN created_by UUID REFERENCES users(id),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE user_team_assignments
SET assignment_kind = 'legacy_seed'
WHERE assignment_kind IS NULL;

ALTER TABLE user_team_assignments
  ALTER COLUMN assignment_kind SET NOT NULL,
  ADD CONSTRAINT user_team_assignments_kind_check
    CHECK (assignment_kind IN ('onboarding', 'admin', 'legacy_seed'));

-- 기존 현재 팀의 의미를 보존한다. 사용되지 않던 이력 테이블이 비어 있으면 처음부터
-- 현재 팀이었던 것으로 seed하고, 수동 이력이 있으면 마지막 기간 뒤부터만 연다.
INSERT INTO user_team_assignments
  (user_id, team_id, effective_from, effective_to, assignment_kind, created_by)
SELECT u.id, u.team_id, '-infinity'::timestamptz, NULL, 'legacy_seed', NULL
FROM users u
WHERE u.team_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_team_assignments a WHERE a.user_id = u.id
  );

INSERT INTO user_team_assignments
  (user_id, team_id, effective_from, effective_to, assignment_kind, created_by)
SELECT u.id, u.team_id, clock_timestamp(), NULL, 'legacy_seed', NULL
FROM users u
WHERE u.team_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM user_team_assignments a WHERE a.user_id = u.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM user_team_assignments a
    WHERE a.user_id = u.id AND a.effective_to IS NULL
  );

ALTER TABLE user_team_assignments
  ADD CONSTRAINT user_team_assignments_valid_period
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  ADD CONSTRAINT user_team_assignments_no_overlap
    EXCLUDE USING gist (
      user_id WITH =,
      tstzrange(effective_from, effective_to, '[)') WITH &&
    );

CREATE UNIQUE INDEX idx_user_team_assignments_open
  ON user_team_assignments (user_id)
  WHERE effective_to IS NULL;

CREATE INDEX idx_user_team_assignments_lookup
  ON user_team_assignments (user_id, effective_from, effective_to);

CREATE TABLE team_attribution_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id     UUID NOT NULL REFERENCES user_team_assignments(id),
  user_id           UUID NOT NULL REFERENCES users(id),
  team_id           UUID NOT NULL REFERENCES teams(id),
  kind              TEXT NOT NULL
                      CHECK (kind IN ('initial_backfill', 'legacy_adoption')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  from_ts           TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  to_ts             TIMESTAMPTZ,
  matched_events    BIGINT NOT NULL DEFAULT 0,
  processed_events  BIGINT NOT NULL DEFAULT 0,
  updated_events    BIGINT NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error        TEXT,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, kind),
  CHECK (to_ts IS NULL OR to_ts > from_ts)
);

CREATE INDEX idx_team_attribution_jobs_claim
  ON team_attribution_jobs (status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE team_attribution_read_fences (
  job_id      UUID PRIMARY KEY REFERENCES team_attribution_jobs(id) ON DELETE CASCADE,
  from_ts     TIMESTAMPTZ NOT NULL,
  to_ts       TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_ts IS NULL OR to_ts > from_ts)
);

CREATE FUNCTION complete_team_attribution_fence(requested_job_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM team_attribution_read_fences WHERE job_id = requested_job_id;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION complete_team_attribution_fence(UUID) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE user_team_assignments FROM toard_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE user_team_assignments TO toard_app;
    REVOKE ALL PRIVILEGES ON TABLE team_attribution_jobs FROM toard_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE team_attribution_jobs TO toard_app;
    REVOKE ALL PRIVILEGES ON TABLE team_attribution_read_fences FROM toard_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE team_attribution_read_fences TO toard_app;
    GRANT EXECUTE ON FUNCTION complete_team_attribution_fence(UUID) TO toard_app;
  END IF;
END $$;

-- Down Migration

DROP FUNCTION complete_team_attribution_fence(UUID);
DROP TABLE team_attribution_read_fences;
DROP TABLE team_attribution_jobs;

DROP INDEX idx_user_team_assignments_lookup;
DROP INDEX idx_user_team_assignments_open;

ALTER TABLE user_team_assignments
  DROP CONSTRAINT user_team_assignments_no_overlap,
  DROP CONSTRAINT user_team_assignments_valid_period,
  DROP CONSTRAINT user_team_assignments_kind_check;

DELETE FROM user_team_assignments
WHERE assignment_kind = 'legacy_seed'
  AND created_by IS NULL
  AND effective_from = '-infinity'::timestamptz;

ALTER TABLE user_team_assignments
  DROP COLUMN created_at,
  DROP COLUMN created_by,
  DROP COLUMN assignment_kind;

ALTER TABLE user_team_assignments
  ALTER COLUMN effective_from TYPE DATE
    USING (effective_from AT TIME ZONE 'UTC')::date,
  ALTER COLUMN effective_to TYPE DATE
    USING (effective_to AT TIME ZONE 'UTC')::date;

ALTER TABLE user_team_assignments
  ADD CONSTRAINT user_team_assignments_user_id_effective_from_key
    UNIQUE (user_id, effective_from);
