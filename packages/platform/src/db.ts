import pg from "pg";
import { Kysely, PostgresDialect, type Generated, type ColumnType } from "kysely";

// int8 (bigint) -> number; our ids stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface DB {
  installations: { id: number; account_login: string; created_at: Generated<Date>; suspended: Generated<boolean> };
  repos: {
    id: Generated<string>;
    github_id: number | null;
    full_name: string;
    installation_id: number | null;
    source: "github-app" | "public" | "fixture";
    default_branch: Generated<string>;
    site_url: string | null;
    baseline_scan_id: string | null;
    created_at: Generated<Date>;
  };
  scans: {
    id: Generated<string>;
    repo_id: string;
    kind: "full" | "pr";
    status: Generated<"ingesting" | "queued" | "running" | "completed" | "failed">;
    ref: string;
    head_sha: string;
    base_sha: string | null;
    base_scan_id: string | null;
    pr_number: number | null;
    check_run_id: number | null;
    trigger: string;
    error: string | null;
    created_at: Generated<Date>;
    started_at: TsNull;
    finished_at: TsNull;
    published_at: TsNull;
  };
  scan_files: { scan_id: string; path: string; blob_sha: string; size: number; to_analyze: boolean };
  scan_jobs: {
    id: Generated<number>;
    scan_id: string;
    path: string;
    status: Generated<"queued" | "analyzing" | "done" | "error" | "skipped">;
    attempts: Generated<number>;
    locked_by: string | null;
    locked_until: TsNull;
    started_at: TsNull;
    finished_at: TsNull;
    duration_ms: number | null;
    cache_hit: Generated<boolean>;
    error: string | null;
  };
  blobs: { sha: string; content: string; fetched_at: Generated<Date> };
  findings: {
    id: Generated<number>;
    scan_id: string;
    path: string;
    rule_id: string | null;
    sc: string;
    severity: string;
    line: number;
    snippet: string;
    message: string;
    suggestion: string | null;
    source: string;
    status: string;
    method: string;
    reason: string;
    fingerprint: string | null;
    selector_hint: string | null;
    element_path: string | null;
    worker_pod: string | null;
    created_at: Generated<Date>;
  };
  analysis_cache: { key: string; candidates: ColumnType<unknown, string, string>; created_at: Generated<Date> };
  webhook_deliveries: {
    id: string;
    event: string;
    payload: ColumnType<unknown, string, string>;
    status: Generated<"pending" | "processing" | "done" | "error" | "ignored">;
    attempts: Generated<number>;
    locked_until: TsNull;
    error: string | null;
    received_at: Generated<Date>;
  };
  sessions: {
    id: string;
    login: string;
    avatar_url: string | null;
    installation_ids: number[];
    created_at: Generated<Date>;
    expires_at: Ts;
  };
  exemptions: { repo_id: string; fingerprint: string; created_by: string; reason: string | null; created_at: Generated<Date> };
  rag_chunks: {
    id: string;
    kind: string;
    sc: string[];
    title: string;
    text: string;
    url: string;
    embedding: string;
  };
}

export function createDb(url: string, max = 5) {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  // An idle client errors when Postgres restarts; without a listener Node would crash the process.
  pool.on("error", (err) => console.error(JSON.stringify({ level: 50, msg: "idle database client error (will reconnect)", err: err.message })));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    ping: async () => {
      await pool.query("select 1");
    },
  };
}
export type Db = Kysely<DB>;
