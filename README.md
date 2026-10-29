# ZK Central (standalone MVP)

A *new* Node.js + PostgreSQL project for the Cairo Ubuntu server, separate from ZK-Integration and Zabbix.

## Scope implemented
- PostgreSQL schema for companies, branches, employees, devices, enrollments, attendance, jobs, audit.
- Localhost-only API. Console sign-in with one username/password (optional; `ADMIN_USERNAME`/`ADMIN_PASSWORD`, at least 12 characters) issues an in-memory session token (30 min idle, 12 h maximum, ended by Lock or a restart; 5 failed attempts in 15 minutes lock sign-in from that address for 1, 2, 4 … up to 15 minutes). The admin token (`X-Admin-Token`) keeps working for scripts and for installations without sign-in. Single shared administrator account; not production-grade identity management.
- Web dashboard: company creation, employee creation, listing. No production-grade authentication.
- **Read-only scan preview (not database import)** of Egypt MB2000 `192.168.1.147:4370` via `node-zklib`.
- No storage of fingerprint templates, no HR/Edara transmissions, no Saudi connectivity.
- **Send employees to a biometric device** (employee profile, or select rows on Employees): identity only, meaning a device user ID and name are written into an empty slot. Fingerprint and face templates are never read or sent; enroll them on the terminal. The read-only preview shows per employee: ready, already on the device, conflict (ID taken on the device or in ZK Central), needs review (registered on another device record with the same ip:port; that registration is not treated as the same one), or blocked. Existing device users, IDs and templates are never overwritten.
  Contacting a terminal needs `ENABLE_DEVICE_READS=true` (otherwise the preview checks ZK Central records only and never connects); writing additionally needs `ENABLE_DEVICE_WRITES=true` and the administrator typing the device name. Both fail closed: anything but exactly `true` is off. Connections go only to the Egypt address and `DEVICE_APPROVED_ADDRESSES`. Each push locks the terminal keypad, re-reads it, writes, reads back to verify, then unlocks. API: `GET /api/device-push/status`, `POST /api/device-push/preview`, `POST /api/device-push/push`. Tests use a mocked terminal (`test/helpers/mock-zk-device.mjs`) and never contact hardware.

## Native Ubuntu setup (no Docker)
Use a nonproduction/staging instance first. Verify ports 5180 and PostgreSQL 5432 do not conflict with existing services. On Ubuntu with Node.js 20+ and PostgreSQL installed:

```bash
The database `zk_central` and user `zk_central_app` are already created and verified. Do not recreate them.
cp .env.example .env
# Edit .env with matching password and generated ADMIN_TOKEN; protect it with chmod 600
npm install
# Set DATABASE_URL in .env using your actual password, URL-encoding special characters in the URL
# Apply schema after reviewing it (initial empty database only):
set -a; . ./.env; set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/schema.sql
# Then apply the numbered migrations in order (003 … 009). 008 adds employee management
# (central number, country, department, status, devices view), 009 additional branches per
# employee; both are safe to re-run. For an existing production database follow
# deploy/DEPLOYMENT_PLAN.md (pre-flight checks, backup, post-flight, smoke test, rollback).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/008_employee_management.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/009_employee_branches.sql
npm start
```

Access with an SSH tunnel from your PC rather than exposing the app to the internet:
`ssh -L 5180:127.0.0.1:5180 user@SERVER_SSH_ADDRESS`
Then open `http://127.0.0.1:5180` on your PC.

### Security and production limitations
- This is a **starter**, not a validated deployment. Run tests and a security review before exposing it to networks or treating it as authoritative HR data.
- The simple admin token is for protected development use only; add full authentication, permissions, CSRF protection, per-tenant access, rate limiting, TLS, and audit events before production rollout.
- Do not place a real fingerprint template in logs, responses, or code. A separate approved hardware compatibility test is required.
- Do not enable employee writes or attendance dispatch until existing Edara and Sanaa HR integrations are verified and a cutover with deduplication is approved.
- Do not install or start anything over the existing ZK-Integration production service.
