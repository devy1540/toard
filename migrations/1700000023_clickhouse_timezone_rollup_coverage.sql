-- Up Migration

-- 완료 job은 7일 뒤 queue에서 정리하되, 400일 timezone cache의 완료 근거는 보존한다.
CREATE TABLE clickhouse_timezone_rollup_coverage (
  resolution TEXT NOT NULL CHECK (resolution IN ('hour', 'day')),
  timezone TEXT NOT NULL REFERENCES clickhouse_rollup_timezones(timezone) ON DELETE CASCADE,
  bucket TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (resolution, timezone, bucket)
);

INSERT INTO clickhouse_timezone_rollup_coverage (resolution, timezone, bucket, updated_at)
SELECT job.resolution, job.timezone, job.bucket, job.updated_at
FROM clickhouse_timezone_rollup_jobs AS job
JOIN clickhouse_rollup_timezones AS registry USING (timezone)
WHERE job.status = 'done'
ON CONFLICT (resolution, timezone, bucket) DO UPDATE
SET updated_at = EXCLUDED.updated_at;

-- Down Migration

DROP TABLE clickhouse_timezone_rollup_coverage;
