-- Up Migration

CREATE TABLE pricing_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  input_price_per_mtok NUMERIC NOT NULL,
  output_price_per_mtok NUMERIC NOT NULL,
  cache_read_price_per_mtok NUMERIC,
  cache_creation_price_per_mtok NUMERIC,
  input_price_above_200k_per_mtok NUMERIC,
  output_price_above_200k_per_mtok NUMERIC,
  fast_multiplier NUMERIC NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, effective_at, source)
);

INSERT INTO pricing_revisions (
  model_id, effective_at, input_price_per_mtok, output_price_per_mtok,
  cache_read_price_per_mtok, cache_creation_price_per_mtok,
  input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
  fast_multiplier, source
)
SELECT
  model_id, effective_date::timestamp AT TIME ZONE 'UTC',
  input_price_per_mtok, output_price_per_mtok,
  cache_read_price_per_mtok, cache_creation_price_per_mtok,
  input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
  fast_multiplier, source
FROM pricing_models;

ALTER TABLE usage_events ADD COLUMN pricing_revision_id UUID REFERENCES pricing_revisions(id);
ALTER TABLE usage_events ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (cost_status IN ('priced', 'unpriced', 'legacy'));

-- Down Migration

ALTER TABLE usage_events DROP COLUMN cost_status;
ALTER TABLE usage_events DROP COLUMN pricing_revision_id;
DROP TABLE pricing_revisions;
