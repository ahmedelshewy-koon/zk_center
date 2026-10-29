BEGIN;

ALTER TABLE api_integrations
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE hr_employee_staging
ADD COLUMN IF NOT EXISTS biometric_number TEXT;

COMMIT;