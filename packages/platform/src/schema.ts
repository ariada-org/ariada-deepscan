/** Idempotent schema (safe to run on every deploy; guarded by an advisory lock). */
export const SCHEMA_SQL = /* sql */ `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS installations (
  id            bigint PRIMARY KEY,
  account_login text NOT NULL,
  suspended     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id        bigint UNIQUE,
  full_name        text NOT NULL UNIQUE,
  installation_id  bigint REFERENCES installations(id) ON DELETE SET NULL,
  source           text NOT NULL CHECK (source IN ('github-app','public','fixture')),
  default_branch   text NOT NULL DEFAULT 'main',
  site_url         text,
  baseline_scan_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repos_site ON repos (site_url);

CREATE TABLE IF NOT EXISTS scans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('full','pr')),
  status        text NOT NULL DEFAULT 'ingesting' CHECK (status IN ('ingesting','queued','running','completed','failed')),
  ref           text NOT NULL,
  head_sha      text NOT NULL,
  base_sha      text,
  base_scan_id  uuid REFERENCES scans(id) ON DELETE SET NULL,
  pr_number     int,
  check_run_id  bigint,
  trigger       text NOT NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  published_at  timestamptz
);
CREATE INDEX IF NOT EXISTS scans_repo ON scans (repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scans_unpublished ON scans (status) WHERE published_at IS NULL;

-- full tree of the snapshot (needed so read_file/list_related can only touch real paths)
CREATE TABLE IF NOT EXISTS scan_files (
  scan_id  uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  path     text NOT NULL,
  blob_sha text NOT NULL,
  size     int  NOT NULL,
  to_analyze boolean NOT NULL,
  PRIMARY KEY (scan_id, path)
);

-- work queue: competing consumers claim rows with FOR UPDATE SKIP LOCKED
CREATE TABLE IF NOT EXISTS scan_jobs (
  id           bigserial PRIMARY KEY,
  scan_id      uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  path         text NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','analyzing','done','error','skipped')),
  attempts     int  NOT NULL DEFAULT 0,
  locked_by    text,
  locked_until timestamptz,
  started_at   timestamptz,
  finished_at  timestamptz,
  duration_ms  int,
  cache_hit    boolean NOT NULL DEFAULT false,
  error        text,
  UNIQUE (scan_id, path)
);
CREATE INDEX IF NOT EXISTS scan_jobs_claim ON scan_jobs (id) WHERE status IN ('queued','analyzing');
CREATE INDEX IF NOT EXISTS scan_jobs_scan ON scan_jobs (scan_id, status);

CREATE TABLE IF NOT EXISTS blobs (
  sha        text PRIMARY KEY,
  content    text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS findings (
  id            bigserial PRIMARY KEY,
  scan_id       uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  path          text NOT NULL,
  rule_id       text,
  sc            text NOT NULL,
  severity      text NOT NULL,
  line          int  NOT NULL,
  snippet       text NOT NULL,
  message       text NOT NULL,
  suggestion    text,
  source        text NOT NULL,
  status        text NOT NULL,
  method        text NOT NULL,
  reason        text NOT NULL,
  fingerprint   text,
  selector_hint text,
  element_path  text,
  worker_pod    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS findings_scan_fp ON findings (scan_id, fingerprint) WHERE fingerprint IS NOT NULL AND status <> 'rejected';
CREATE INDEX IF NOT EXISTS findings_scan_path ON findings (scan_id, path);

CREATE TABLE IF NOT EXISTS analysis_cache (
  key        text PRIMARY KEY,
  candidates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           text PRIMARY KEY,
  event        text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  attempts     int  NOT NULL DEFAULT 0,
  locked_until timestamptz,
  error        text,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_pending ON webhook_deliveries (received_at) WHERE status IN ('pending','processing');

CREATE TABLE IF NOT EXISTS sessions (
  id               text PRIMARY KEY,
  login            text NOT NULL,
  avatar_url       text,
  installation_ids bigint[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS exemptions (
  repo_id     uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  created_by  text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id        text PRIMARY KEY,
  kind      text NOT NULL,
  sc        text[] NOT NULL DEFAULT '{}',
  title     text NOT NULL,
  text      text NOT NULL,
  url       text NOT NULL,
  embedding vector(256) NOT NULL,
  tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || text)) STORED
);
CREATE INDEX IF NOT EXISTS rag_tsv ON rag_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS rag_vec ON rag_chunks USING hnsw (embedding vector_cosine_ops);
`;
