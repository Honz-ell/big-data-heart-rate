CREATE TABLE IF NOT EXISTS stress_predictions (
    subject_id TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    prediction TEXT NOT NULL CHECK (prediction IN ('STRESS', 'NON_STRESS')),
    model_score_stress DOUBLE PRECISION NOT NULL CHECK (model_score_stress >= 0 AND model_score_stress <= 1),
    model_file TEXT NOT NULL,
    model_version TEXT,
    sample_counts JSONB NOT NULL,
    vitals JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subject_id, window_start)
);

ALTER TABLE stress_predictions
    ADD COLUMN IF NOT EXISTS vitals JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_stress_predictions_window_start
    ON stress_predictions (window_start DESC);

CREATE TABLE IF NOT EXISTS sensor_window_aggregates (
    subject_id TEXT NOT NULL,
    window_start_utc TIMESTAMPTZ NOT NULL,
    window_end_utc TIMESTAMPTZ NOT NULL,
    sensor TEXT NOT NULL,
    unit TEXT NOT NULL,
    sample_count BIGINT NOT NULL,
    mean_value DOUBLE PRECISION NOT NULL,
    min_value DOUBLE PRECISION NOT NULL,
    max_value DOUBLE PRECISION NOT NULL,
    spark_batch_id BIGINT NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sensor_window_aggregates_time
    ON sensor_window_aggregates (window_start_utc DESC);

CREATE INDEX IF NOT EXISTS idx_sensor_window_aggregates_subject_time
    ON sensor_window_aggregates (subject_id, window_start_utc DESC);

CREATE TABLE IF NOT EXISTS prediction_feedback (
    subject_id TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('ACCURATE', 'FALSE_ALARM')),
    note TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subject_id, window_start)
);

CREATE TABLE IF NOT EXISTS replay_stream_clock (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    reserved_until_epoch DOUBLE PRECISION NOT NULL DEFAULT 0
);

INSERT INTO replay_stream_clock (singleton, reserved_until_epoch)
VALUES (TRUE, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS model_versions (
    version TEXT PRIMARY KEY,
    model_file TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    feature_schema_version TEXT NOT NULL DEFAULT 'v1',
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_model_versions_single_active
    ON model_versions (is_active) WHERE is_active;
