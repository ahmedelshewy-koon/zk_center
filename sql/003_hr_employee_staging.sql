CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS hr_employee_staging (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    central_uid TEXT UNIQUE,
    hr_employee_code TEXT NOT NULL UNIQUE,
    name_en TEXT,
    name_ar TEXT,
    work_email TEXT,
    work_phone TEXT,
    department TEXT,
    job_title TEXT,
    start_date TEXT,
    end_date TEXT,
    employment_status TEXT,
    country TEXT,
    work_location TEXT,
    employment_type TEXT,
    tenant_id TEXT,
    company_id TEXT,
    home_branch_id TEXT,
    biometric_uid TEXT,
    device_ids TEXT,
    sync_enabled TEXT,
    import_status TEXT NOT NULL DEFAULT 'PENDING_COMPANY_MAPPING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
