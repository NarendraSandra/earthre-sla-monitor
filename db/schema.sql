CREATE TABLE IF NOT EXISTS upload_batches (
  id uuid PRIMARY KEY,
  file_name text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  total_rows integer NOT NULL,
  accepted_rows integer NOT NULL,
  rejected_rows integer NOT NULL,
  duplicate_rows integer NOT NULL,
  range_start timestamptz,
  range_end timestamptz,
  quality_report jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS service_checks (
  id bigserial PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  service_name text NOT NULL,
  checked_at timestamptz NOT NULL,
  status_code integer NOT NULL,
  latency_ms double precision,
  agent text NOT NULL,
  region text NOT NULL,
  is_available boolean NOT NULL,
  source_row integer NOT NULL,
  warnings text[] NOT NULL DEFAULT '{}',
  UNIQUE (upload_id, service_id, checked_at)
);

CREATE INDEX IF NOT EXISTS service_checks_upload_time_idx
ON service_checks (upload_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS service_checks_upload_service_idx
ON service_checks (upload_id, service_id);
