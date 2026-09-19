-- Observability (pre-launch Audit 4, 2026-09-19): the tables behind the standing alerts.
-- Additive only - three new tables, nothing existing is altered.
--
--   ops_job_runs - one row per scheduled-job call, reported by the cron Workers at the
--                  end of each chain (POST /api/ops/job-report). The hourly health check
--                  reads it for "did every job run, and did it succeed". Before this,
--                  nothing recorded a run: a quiet night and a dead cron looked the same.
--   ops_events   - security- and error-relevant request outcomes recorded by
--                  functions/_middleware.ts: machine-secret rejections, CSRF rejections,
--                  throttle hits, rejected requests on the Ember/trading endpoints, and
--                  every 5xx. IPs are stored only as a salted hash. Pruned at 30 days.
--   ops_alerts   - one row per alert condition (e.g. 'ledger:ember'), so an ongoing
--                  problem emails once and then at most every few hours, and clearing it
--                  sends a single "resolved" email. Also dedupes the daily summary.
--
-- Execute: psql "$DATABASE_URL" -f create_ops_tables.sql

BEGIN;

CREATE TABLE IF NOT EXISTS ops_job_runs (
    id          BIGSERIAL PRIMARY KEY,
    job         TEXT NOT NULL,              -- e.g. 'settle', 'index-settle', 'curate-sport:Soccer'
    trigger     TEXT NOT NULL,              -- the cron expression or 'manual'
    target      TEXT NOT NULL,              -- 'preview' | 'production'
    ok          BOOLEAN NOT NULL,
    status      INT,                        -- HTTP status; NULL when the call threw
    duration_ms INT,
    errors      INT NOT NULL DEFAULT 0,     -- error count the job's own body reported
    summary     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ops_job_runs_job_created ON ops_job_runs (job, created_at DESC);

CREATE TABLE IF NOT EXISTS ops_events (
    id         BIGSERIAL PRIMARY KEY,
    kind       TEXT NOT NULL,               -- 'auth_reject' | 'csrf_reject' | 'throttle' | 'rejected' | 'server_error'
    path       TEXT NOT NULL,
    status     INT NOT NULL,
    ip_hash    TEXT,
    detail     JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ops_events_kind_created ON ops_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_events_ip_created ON ops_events (ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS ops_alerts (
    key         TEXT PRIMARY KEY,
    first_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- last time an email went out for it
    count       INT NOT NULL DEFAULT 1,              -- emails sent while open
    resolved_at TIMESTAMPTZ,
    detail      TEXT
);

COMMIT;
