/**
 * Queue worker (competing consumers). Jobs are claimed with
 * SELECT … FOR UPDATE SKIP LOCKED and a lease (locked_until); a crashed pod's
 * jobs become claimable again when the lease expires, up to 3 attempts.
 */
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { Db, Logger } from "@deepscan/platform";
import { callJson, counter, gauge } from "@deepscan/platform";
import { CandidateFinding, FileContentResponse, VerifyResponse, RepoPath, ScanId } from "@deepscan/contracts";
import type { LlmProvider } from "./providers/types.js";
import { runAgent } from "./agent.js";
import { runRules } from "./tools.js";
import { env } from "./env.js";

const jobsDone = counter("agent_jobs_total", "File jobs finished, by outcome");
const cacheHits = counter("agent_cache_hits_total", "Analysis cache hits");
const busy = gauge("agent_busy_workers", "Workers currently analysing a file");
const findingsOut = counter("agent_findings_total", "Findings written, by verdict and source");

interface Job { id: number; scan_id: string; path: string; attempts: number }

async function claim(db: Db): Promise<Job | null> {
  return db.transaction().execute(async (tx) => {
    const r = await sql<Job>`
      SELECT id, scan_id, path, attempts FROM scan_jobs
      WHERE (status = 'queued' OR (status = 'analyzing' AND locked_until < now())) AND attempts < 3
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(tx);
    const job = r.rows[0];
    if (!job) return null;
    await tx.updateTable("scan_jobs").set({
      status: "analyzing", locked_by: env.POD_NAME, attempts: job.attempts + 1, started_at: new Date(),
      locked_until: sql<Date>`now() + make_interval(secs => ${env.JOB_LEASE_SECONDS})`,
    }).where("id", "=", job.id).execute();
    await tx.updateTable("scans").set({ status: "running" }).where("id", "=", job.scan_id).where("status", "=", "queued").execute();
    return job;
  });
}

/**
 * Mark the scan complete when no job is pending. The scan row lock serialises concurrent finishers.
 * NO KEY UPDATE, not UPDATE: the findings just inserted in this transaction hold a KEY SHARE lock on the
 * same row through their foreign key, and two finishers upgrading that to FOR UPDATE deadlock each other.
 */
async function maybeCompleteScan(tx: Db, scanId: string) {
  await sql`SELECT id FROM scans WHERE id = ${scanId} FOR NO KEY UPDATE`.execute(tx);
  const open = await tx.selectFrom("scan_jobs").select(sql<number>`count(*)::int`.as("n")).where("scan_id", "=", scanId).where("status", "in", ["queued", "analyzing"]).executeTakeFirstOrThrow();
  if (open.n === 0) await tx.updateTable("scans").set({ status: "completed", finished_at: new Date() }).where("id", "=", scanId).where("status", "in", ["queued", "running"]).execute();
}

const CachedCandidates = z.array(CandidateFinding.omit({ path: true }));

export async function analyse(p: LlmProvider, f: { scanId: ScanId | null; path: RepoPath; content: string }, log: Logger) {
  const rules = await runRules(f.path, f.content);
  const key = createHash("sha256").update(`${env.PROMPT_VERSION}|${p.name}|${p.model}|${f.path.split(".").pop()}|${f.content}`).digest("hex");
  return { rules, key, llm: (dbCache?: { get: () => Promise<CandidateFinding[] | null>; put: (c: CandidateFinding[]) => Promise<void> }) => llmPass(p, f, rules, log, dbCache) };
}

async function llmPass(p: LlmProvider, f: { scanId: ScanId | null; path: RepoPath; content: string }, rules: CandidateFinding[], log: Logger, cache?: { get: () => Promise<CandidateFinding[] | null>; put: (c: CandidateFinding[]) => Promise<void> }) {
  const hit = cache ? await cache.get() : null;
  if (hit) return { candidates: hit, cacheHit: true, stats: null };
  const r = await runAgent(p, f, rules, log);
  if (cache) await cache.put(r.candidates);
  return { candidates: r.candidates, cacheHit: false, stats: r };
}

export async function verify(path: RepoPath, content: string, candidates: CandidateFinding[]) {
  const out: z.output<typeof VerifyResponse>["results"] = [];
  for (let i = 0; i < candidates.length; i += 200)
    out.push(...(await callJson({ url: `${env.VERIFIER_URL}/verify`, body: { path, content, candidates: candidates.slice(i, i + 200) }, schema: VerifyResponse })).results);
  return out;
}

async function processJob(db: Db, p: LlmProvider, job: Job, log: Logger) {
  const t0 = Date.now();
  const scanId = ScanId.parse(job.scan_id);
  const path = RepoPath.parse(job.path);
  const file = await callJson({ url: `${env.CONNECTOR_URL}/internal/scans/${scanId}/file?path=${encodeURIComponent(path)}`, schema: FileContentResponse });
  const a = await analyse(p, { scanId, path, content: file.content }, log);
  const llm = await a.llm({
    get: async () => {
      const row = await db.selectFrom("analysis_cache").select("candidates").where("key", "=", a.key).executeTakeFirst();
      if (!row) return null;
      cacheHits.inc();
      return CachedCandidates.parse(row.candidates).map((c) => ({ ...c, path }));
    },
    put: async (c) => {
      await db.insertInto("analysis_cache").values({ key: a.key, candidates: JSON.stringify(c.map(({ path: _p, ...rest }) => rest)) }).onConflict((oc) => oc.column("key").doNothing()).execute();
    },
  });
  const results = await verify(path, file.content, [...a.rules, ...llm.candidates]);

  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom("findings").where("scan_id", "=", scanId).where("path", "=", path).execute();
    for (const { candidate: c, verdict: v } of results) {
      await tx.insertInto("findings").values({
        scan_id: scanId, path, rule_id: c.ruleId, sc: c.sc, severity: c.severity, line: v.line, snippet: c.snippet,
        message: c.message, suggestion: c.suggestion, source: c.source, status: v.status, method: v.method, reason: v.reason,
        fingerprint: v.status === "rejected" ? null : v.fingerprint, selector_hint: v.selectorHint, element_path: v.elementPath, worker_pod: env.POD_NAME,
      }).onConflict((oc) => oc.columns(["scan_id", "fingerprint"]).where("fingerprint", "is not", null).where("status", "<>", "rejected").doNothing()).execute();
      findingsOut.inc({ status: v.status, source: c.source });
    }
    await tx.updateTable("scan_jobs").set({ status: "done", finished_at: new Date(), duration_ms: Date.now() - t0, cache_hit: llm.cacheHit, error: null, locked_until: null }).where("id", "=", job.id).execute();
    await maybeCompleteScan(tx, scanId);
  });
  const by = (s: string) => results.filter((r) => r.verdict.status === s).length;
  log.info({ scanId, path, ms: Date.now() - t0, cacheHit: llm.cacheHit, rules: a.rules.length, llm: llm.candidates.length, verified: by("verified"), unverifiable: by("unverifiable"), rejected: by("rejected"), turns: llm.stats?.turns, schemaErrors: llm.stats?.schemaErrors }, "file analysed");
}

async function failJob(db: Db, job: Job, err: string) {
  await db.transaction().execute(async (tx) => {
    const final = job.attempts + 1 >= 3;
    await tx.updateTable("scan_jobs").set({ status: final ? "error" : "queued", error: err.slice(0, 500), locked_until: null, finished_at: final ? new Date() : null }).where("id", "=", job.id).execute();
    if (final) await maybeCompleteScan(tx, job.scan_id);
  });
}

/** Leases that expired on the last attempt → error, so the scan can still complete. */
async function sweep(db: Db) {
  const dead = await db.updateTable("scan_jobs").set({ status: "error", error: "lease expired after max attempts", finished_at: new Date() })
    .where("status", "=", "analyzing").where("attempts", ">=", 3).where("locked_until", "<", sql<Date>`now()`).returning("scan_id").execute();
  for (const scanId of new Set(dead.map((d) => d.scan_id))) await db.transaction().execute((tx) => maybeCompleteScan(tx, scanId));
}

export function startWorkers(db: Db, p: LlmProvider, log: Logger, n: number) {
  let stopped = false;
  const one = async (i: number) => {
    let idle = 0;
    while (!stopped) {
      try {
        if (i === 0 && ++idle % 30 === 0) await sweep(db);
        const job = await claim(db);
        if (!job) {
          await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500));
          continue;
        }
        busy.inc({}, 1);
        try {
          await processJob(db, p, job, log);
          jobsDone.inc({ outcome: "done" });
        } catch (e) {
          jobsDone.inc({ outcome: "error" });
          log.error({ job: job.id, path: job.path, err: (e as Error).message }, "job failed");
          await failJob(db, job, (e as Error).message);
        } finally {
          busy.inc({}, -1);
        }
      } catch (e) {
        log.error({ err: (e as Error).message }, "worker loop error");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  for (let i = 0; i < n; i++) void one(i);
  return () => {
    stopped = true;
  };
}
