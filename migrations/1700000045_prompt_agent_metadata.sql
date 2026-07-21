-- Up Migration
-- prompt_records에 메인/서브에이전트 실행 계층을 보존한다.
-- 기존 행은 agent_id=NULL인 메인 실행으로 해석해 하위 호환한다.

ALTER TABLE prompt_records
  ADD COLUMN agent_id        TEXT,
  ADD COLUMN parent_agent_id TEXT,
  ADD COLUMN agent_depth     SMALLINT,
  ADD COLUMN agent_name      TEXT,
  ADD COLUMN agent_role      TEXT;

ALTER TABLE prompt_records
  ADD CONSTRAINT prompt_records_agent_id_length
    CHECK (agent_id IS NULL OR char_length(agent_id) BETWEEN 1 AND 255),
  ADD CONSTRAINT prompt_records_parent_agent_id_length
    CHECK (parent_agent_id IS NULL OR char_length(parent_agent_id) BETWEEN 1 AND 255),
  ADD CONSTRAINT prompt_records_agent_depth_range
    CHECK (agent_depth IS NULL OR agent_depth BETWEEN 1 AND 32),
  ADD CONSTRAINT prompt_records_agent_name_length
    CHECK (agent_name IS NULL OR char_length(agent_name) BETWEEN 1 AND 100),
  ADD CONSTRAINT prompt_records_agent_role_length
    CHECK (agent_role IS NULL OR char_length(agent_role) BETWEEN 1 AND 100),
  ADD CONSTRAINT prompt_records_agent_shape
    CHECK (
      (agent_id IS NULL AND parent_agent_id IS NULL AND agent_depth IS NULL
        AND agent_name IS NULL AND agent_role IS NULL)
      OR agent_id IS NOT NULL
    );

CREATE INDEX idx_prompt_records_session_agent_ts
  ON prompt_records (user_id, session_id, agent_id, ts);

-- Down Migration
DROP INDEX IF EXISTS idx_prompt_records_session_agent_ts;
ALTER TABLE prompt_records
  DROP CONSTRAINT IF EXISTS prompt_records_agent_shape,
  DROP CONSTRAINT IF EXISTS prompt_records_agent_role_length,
  DROP CONSTRAINT IF EXISTS prompt_records_agent_name_length,
  DROP CONSTRAINT IF EXISTS prompt_records_agent_depth_range,
  DROP CONSTRAINT IF EXISTS prompt_records_parent_agent_id_length,
  DROP CONSTRAINT IF EXISTS prompt_records_agent_id_length,
  DROP COLUMN IF EXISTS agent_role,
  DROP COLUMN IF EXISTS agent_name,
  DROP COLUMN IF EXISTS agent_depth,
  DROP COLUMN IF EXISTS parent_agent_id,
  DROP COLUMN IF EXISTS agent_id;
