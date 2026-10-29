CREATE TABLE IF NOT EXISTS api_integrations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name TEXT NOT NULL,
 endpoint_url TEXT NOT NULL,
 token_ciphertext TEXT NOT NULL,
 is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_integration_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 integration_id UUID REFERENCES api_integrations(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 employee_id UUID,
 status TEXT NOT NULL,
 response_code INTEGER,
 detail TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_integration_logs_recent ON api_integration_logs(created_at DESC);
