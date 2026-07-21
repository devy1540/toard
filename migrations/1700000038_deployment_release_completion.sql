-- Up Migration

-- Helm rollout readiness의 완료 증표다. release_completion_id는 비밀이 아닌
-- deterministic 배포 식별자이며, 과거 행은 구/신 Pod가 함께 ready일 수 있도록 보존한다.
CREATE TABLE deployment_release_completions (
  deployment_id          TEXT NOT NULL,
  release_completion_id  TEXT NOT NULL,
  expected_schema_version BIGINT NOT NULL,
  completed_at           TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT deployment_release_completions_pkey
    PRIMARY KEY (deployment_id, release_completion_id),
  CONSTRAINT deployment_release_completions_id_key
    UNIQUE (release_completion_id),
  CONSTRAINT deployment_release_completions_deployment_id_check CHECK (
    char_length(deployment_id) BETWEEN 3 AND 127
    AND deployment_id ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?/[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
  ),
  CONSTRAINT deployment_release_completions_id_check CHECK (
    char_length(release_completion_id) = 64
    AND release_completion_id ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT deployment_release_completions_schema_version_check CHECK (
    expected_schema_version BETWEEN 1 AND 9223372036854775807
  )
);

REVOKE ALL PRIVILEGES ON TABLE deployment_release_completions FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE deployment_release_completions FROM toard_app;
    GRANT SELECT ON TABLE deployment_release_completions TO toard_app;
  END IF;
END $$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM deployment_release_completions) THEN
    RAISE EXCEPTION 'migration 38 rollback blocked: deployment release completion data exists';
  END IF;
END $$;

DROP TABLE deployment_release_completions;
