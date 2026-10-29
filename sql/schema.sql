CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), name text NOT NULL,
  country text NOT NULL, UNIQUE(company_id,name)
);
CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  home_branch_id uuid REFERENCES branches(id), employee_code text NOT NULL, full_name text NOT NULL,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,employee_code)
);
CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id), name text NOT NULL, model text,
  ip text, port integer NOT NULL DEFAULT 4370, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS device_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL REFERENCES devices(id),
  employee_id uuid NOT NULL REFERENCES employees(id), device_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'IMPORTED', verified_at timestamptz,
  UNIQUE(device_id,device_user_id), UNIQUE(device_id,employee_id)
);
CREATE TABLE IF NOT EXISTS attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  device_id uuid NOT NULL REFERENCES devices(id), employee_id uuid REFERENCES employees(id),
  device_user_id text NOT NULL, punched_at timestamptz NOT NULL, source_event_key text NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE(device_id,source_event_key)
);
CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  device_id uuid REFERENCES devices(id), employee_id uuid REFERENCES employees(id),
  operation text NOT NULL, status text NOT NULL DEFAULT 'PENDING', error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
 id bigserial PRIMARY KEY, action text NOT NULL, entity_type text NOT NULL, entity_id text,
 details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
