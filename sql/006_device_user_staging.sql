BEGIN;

CREATE TABLE IF NOT EXISTS device_user_staging (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES devices(id),
    device_uid TEXT NOT NULL,
    device_user_id TEXT NOT NULL,
    device_name TEXT,
    matched_employee_id UUID REFERENCES employees(id),
    review_status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT device_user_staging_review_status_check
      CHECK (review_status IN ('NEEDS_REVIEW', 'LINKED', 'IGNORED')),

    UNIQUE (device_id, device_uid)
);

COMMIT;
