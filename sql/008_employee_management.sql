BEGIN;

-- Departments are scoped per company.
CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, name)
);

-- Central employee number: system-wide, generated automatically, never reused.
CREATE SEQUENCE IF NOT EXISTS employee_central_no_seq START WITH 100001;

ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS central_no BIGINT NOT NULL DEFAULT nextval('employee_central_no_seq'),
    ADD COLUMN IF NOT EXISTS name_ar TEXT,
    ADD COLUMN IF NOT EXISTS country TEXT,
    ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id),
    ADD COLUMN IF NOT EXISTS job_title TEXT,
    ADD COLUMN IF NOT EXISTS phone TEXT,
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS hire_date DATE,
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';

ALTER SEQUENCE employee_central_no_seq OWNED BY employees.central_no;

DO $$ BEGIN
    ALTER TABLE employees ADD CONSTRAINT employees_central_no_key UNIQUE (central_no);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE employees ADD CONSTRAINT employees_status_check
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'TERMINATED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill from the legacy active flag and the home branch country.
UPDATE employees SET status = 'INACTIVE' WHERE NOT active AND status = 'ACTIVE';
-- Older builds stored branch country as typed; accept the same aliases as src/employees.js.
-- Unrecognised values stay NULL (never a non-code value) and are listed by the pre-flight checks.
UPDATE employees e
SET country = CASE upper(btrim(b.country))
        WHEN 'EG' THEN 'EG' WHEN 'EGYPT' THEN 'EG' WHEN 'مصر' THEN 'EG'
        WHEN 'SA' THEN 'SA' WHEN 'KSA' THEN 'SA' WHEN 'SAUDI' THEN 'SA' WHEN 'SAUDI ARABIA' THEN 'SA'
        WHEN 'السعودية' THEN 'SA' WHEN 'المملكة العربية السعودية' THEN 'SA'
        WHEN 'JO' THEN 'JO' WHEN 'JORDAN' THEN 'JO' WHEN 'الأردن' THEN 'JO' WHEN 'الاردن' THEN 'JO'
        END
FROM branches b
WHERE b.id = e.home_branch_id AND e.country IS NULL;

-- Keep the legacy active flag (used by enrollment and integrations) in step with status.
CREATE OR REPLACE FUNCTION employees_sync_active() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.active IS DISTINCT FROM OLD.active THEN
        NEW.status := CASE WHEN NEW.active THEN 'ACTIVE' ELSE 'INACTIVE' END;
    END IF;
    NEW.active := (NEW.status = 'ACTIVE');
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employees_sync_active ON employees;
CREATE TRIGGER employees_sync_active BEFORE INSERT OR UPDATE ON employees
    FOR EACH ROW EXECUTE FUNCTION employees_sync_active();

CREATE INDEX IF NOT EXISTS idx_employees_filters ON employees (company_id, country, home_branch_id, department_id, status);
CREATE INDEX IF NOT EXISTS idx_employees_name ON employees (lower(full_name));

-- Every device an employee is known on, whichever path created the link.
CREATE OR REPLACE VIEW employee_device_registrations AS
SELECT DISTINCT ON (employee_id, device_id) employee_id, device_id, device_user_id, source, linked_at
FROM (
    SELECT employee_id, device_id, device_user_id, 'PUSHED' AS source, created_at AS linked_at, 1 AS rank
    FROM device_employee_links
    UNION ALL
    SELECT employee_id, device_id, device_user_id, 'ENROLLED', verified_at, 2
    FROM device_enrollments
    UNION ALL
    SELECT matched_employee_id, device_id, device_user_id, 'MATCHED', last_seen_at, 3
    FROM device_user_staging WHERE matched_employee_id IS NOT NULL
) r
ORDER BY employee_id, device_id, rank;

-- POST /api/devices relies on this for ON CONFLICT (company_id, ip, port) WHERE ip IS NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS devices_company_ip_port_key ON devices (company_id, ip, port) WHERE ip IS NOT NULL;

COMMIT;
