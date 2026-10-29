CREATE TABLE IF NOT EXISTS device_employee_links (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 device_id UUID NOT NULL REFERENCES devices(id),
 employee_id UUID NOT NULL REFERENCES employees(id),
 device_uid TEXT NOT NULL,
 device_user_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(device_id,employee_id),
 UNIQUE(device_id,device_uid),
 UNIQUE(device_id,device_user_id)
);
