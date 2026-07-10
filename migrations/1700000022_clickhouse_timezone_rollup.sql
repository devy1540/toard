-- Up Migration

CREATE TABLE clickhouse_rollup_timezones (
  timezone TEXT PRIMARY KEY,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clickhouse_timezone_rollup_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution TEXT NOT NULL CHECK (resolution IN ('hour', 'day')),
  timezone TEXT NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'inflight', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resolution, timezone, bucket)
);

CREATE INDEX clickhouse_timezone_rollup_jobs_pending_idx
  ON clickhouse_timezone_rollup_jobs (created_at, id)
  WHERE status = 'pending';

-- Down Migration

DROP TABLE clickhouse_timezone_rollup_jobs;
DROP TABLE clickhouse_rollup_timezones;
