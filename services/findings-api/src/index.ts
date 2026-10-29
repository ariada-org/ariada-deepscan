import { z } from "zod";
import { sql } from "kysely";
import {
  Me, ReposResponse, ScansResponse, ScanSummary, TreeResponse, ProgressResponse, FindingsResponse, DiffResponse,
  SiteFindingsResponse, ErrorResponse, ScanId, RepoId, RepoPath, VerdictStatus, understandingUrl, type WcagSc,
} from "@deepscan/contracts";
import { BaseEnv, DbEnv, loadEnv, createService, listen, createDb, sessionFromCookie, readCookie, SESSION_COOKIE, bool, type Session } from "@deepscan/platform";
import { canSee, scanSummary, toRecord, diffScans } from "./queries.js";

const env = loadEnv(BaseEnv.extend(DbEnv.shape).extend({
  ALLOW_PUBLIC_SCANS: bool.default(true),
  /** extra origins allowed to call the plugin endpoint (chrome-extension://… is always allowed) */
  PLUGIN_ORIGINS: z.string().default(""),
}));
const { db, ping } = createDb(env.DATABASE_URL, env.DB_POOL_MAX);
const app = await createService({ name: "findings-api", podName: env.POD_NAME, logLevel: env.LOG_LEVEL, ready: ping });

const session = (h: string | undefined): Promise<Session | null> => sessionFromCookie(db, readCookie(h, SESSION_COOKIE));
const pluginOrigins = new Set(env.PLUGIN_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean));

app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (req.url.startsWith("/api/findings") && origin && (/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || pluginOrigins.has(origin))) {
    reply.header("access-control-allow-origin", origin).header("access-control-allow-credentials", "true").header("vary", "origin");
  }
});

/** load a scan the caller may see, or reply 404 (not 403: do not leak existence) */
async function visibleScan(id: string, cookie: string | undefined) {
  const s = await scanSummary(db, id);
  if (!s || !canSee(s.repo, await session(cookie))) return null;
  return s;
}

app.get("/api/me", { schema: { response: { 200: Me } } }, async (req) => {
  const s = await session(req.headers.cookie);
  return { authenticated: !!s, login: s?.login ?? null, avatarUrl: s?.avatarUrl ?? null, installations: s?.installationIds ?? [], publicScansEnabled: env.ALLOW_PUBLIC_SCANS };
});

app.get("/api/repos", { schema: { response: { 200: ReposResponse } } }, async (req) => {
  const s = await session(req.headers.cookie);
  const rows = await db.selectFrom("repos").selectAll().orderBy("created_at", "desc").limit(200).execute();
  const visible = rows.filter((r) => canSee(r, s));
  const repos = [];
  for (const r of visible) {
    const last = await db.selectFrom("scans").select(["id", "status", "created_at"]).where("repo_id", "=", r.id).orderBy("created_at", "desc").executeTakeFirst();
    repos.push({ id: r.id, fullName: r.full_name, defaultBranch: r.default_branch, siteUrl: r.site_url, source: r.source, lastScan: last ? { id: last.id, status: last.status, createdAt: last.created_at.toISOString() } : null });
  }
  return ReposResponse.parse({ repos });
});

app.get("/api/repos/:id/scans", { schema: { params: z.object({ id: RepoId }), response: { 200: ScansResponse, 404: ErrorResponse } } }, async (req, reply) => {
  const repo = await db.selectFrom("repos").selectAll().where("id", "=", req.params.id).executeTakeFirst();
  if (!repo || !canSee(repo, await session(req.headers.cookie))) return reply.code(404).send({ error: "not found" });
  const ids = await db.selectFrom("scans").select("id").where("repo_id", "=", repo.id).orderBy("created_at", "desc").limit(50).execute();
  const scans = [];
  for (const { id } of ids) scans.push((await scanSummary(db, id))!.summary);
  return { scans };
});

const scanParams = { params: z.object({ id: ScanId }) };

app.get("/api/scans/:id", { schema: { ...scanParams, response: { 200: ScanSummary, 404: ErrorResponse } } }, async (req, reply) => {
  const s = await visibleScan(req.params.id, req.headers.cookie);
  return s ? s.summary : reply.code(404).send({ error: "not found" });
});

app.get("/api/scans/:id/tree", { schema: { ...scanParams, response: { 200: TreeResponse, 404: ErrorResponse } } }, async (req, reply) => {
  const s = await visibleScan(req.params.id, req.headers.cookie);
  if (!s) return reply.code(404).send({ error: "not found" });
  const rows = await sql<{ path: string; status: string; locked_by: string | null; duration_ms: number | null; cache_hit: boolean; error: string | null; verified: number; unverifiable: number; rejected: number }>`
    SELECT j.path, j.status, j.locked_by, j.duration_ms, j.cache_hit, j.error,
      count(f.id) FILTER (WHERE f.status = 'verified')::int AS verified,
      count(f.id) FILTER (WHERE f.status = 'unverifiable')::int AS unverifiable,
      count(f.id) FILTER (WHERE f.status = 'rejected')::int AS rejected
    FROM scan_jobs j LEFT JOIN findings f ON f.scan_id = j.scan_id AND f.path = j.path
    WHERE j.scan_id = ${req.params.id}
    GROUP BY j.id ORDER BY j.path`.execute(db);
  return TreeResponse.parse({
    scan: s.summary,
    files: rows.rows.map((r) => ({ path: r.path, status: r.status, workerPod: r.locked_by, verified: r.verified, unverifiable: r.unverifiable, rejected: r.rejected, durationMs: r.duration_ms, cacheHit: r.cache_hit, error: r.error })),
  });
});

app.get("/api/scans/:id/progress", { schema: { ...scanParams, response: { 200: ProgressResponse, 404: ErrorResponse } } }, async (req, reply) => {
  const s = await visibleScan(req.params.id, req.headers.cookie);
  if (!s) return reply.code(404).send({ error: "not found" });
  const id = req.params.id;
  const by = await db.selectFrom("scan_jobs").select(["status", sql<number>`count(*)::int`.as("n")]).where("scan_id", "=", id).groupBy("status").execute();
  const pods = await db.selectFrom("scan_jobs").select(["locked_by", sql<number>`count(*)::int`.as("n")]).where("scan_id", "=", id).where("status", "=", "done").where("locked_by", "is not", null).groupBy("locked_by").orderBy("locked_by").execute();
  const f = await db.selectFrom("findings").select(["status", sql<number>`count(*)::int`.as("n")]).where("scan_id", "=", id).groupBy("status").execute();
  const scan = await db.selectFrom("scans").select(["created_at", "finished_at"]).where("id", "=", id).executeTakeFirstOrThrow();
  return {
    scanId: s.summary.id, status: s.summary.status, total: by.reduce((a, r) => a + r.n, 0),
    byStatus: Object.fromEntries(by.map((r) => [r.status, r.n])), pods: pods.map((p) => ({ pod: p.locked_by!, files: p.n })),
    findings: Object.fromEntries(f.map((r) => [r.status, r.n])),
    elapsedMs: (scan.finished_at ?? new Date()).getTime() - scan.created_at.getTime(),
  };
});

app.get(
  "/api/scans/:id/findings",
  { schema: { ...scanParams, querystring: z.object({ path: RepoPath.optional(), status: VerdictStatus.optional() }), response: { 200: FindingsResponse, 404: ErrorResponse } } },
  async (req, reply) => {
    if (!(await visibleScan(req.params.id, req.headers.cookie))) return reply.code(404).send({ error: "not found" });
    let q = db.selectFrom("findings").selectAll().where("scan_id", "=", req.params.id);
    if (req.query.path) q = q.where("path", "=", req.query.path);
    if (req.query.status) q = q.where("status", "=", req.query.status);
    const rows = await q.orderBy("path").orderBy("line").limit(2000).execute();
    return { findings: rows.map(toRecord) };
  },
);

app.get("/api/scans/:base/diff/:head", { schema: { params: z.object({ base: ScanId, head: ScanId }), response: { 200: DiffResponse, 404: ErrorResponse } } }, async (req, reply) => {
  const a = await visibleScan(req.params.base, req.headers.cookie);
  const b = await visibleScan(req.params.head, req.headers.cookie);
  if (!a || !b || a.repo.id !== b.repo.id) return reply.code(404).send({ error: "not found" });
  return DiffResponse.parse(await diffScans(db, req.params.base, req.params.head));
});

/* cluster-internal (used by github-connector's publisher; not routed by the Ingress) */
app.get("/internal/diff", { schema: { querystring: z.object({ base: ScanId, head: ScanId }), response: { 200: DiffResponse } } }, async (req) =>
  DiffResponse.parse(await diffScans(db, req.query.base, req.query.head)),
);

/* browser-extension overlay: verified findings for the site currently open */
app.get("/api/findings", { schema: { querystring: z.object({ site: z.string().url().max(300) }), response: { 200: SiteFindingsResponse } } }, async (req) => {
  const origin = new URL(req.query.site).origin;
  const s = await session(req.headers.cookie);
  const repos = (await db.selectFrom("repos").selectAll().where(sql<boolean>`rtrim(site_url, '/') = ${origin}`).execute()).filter((r) => canSee(r, s));
  const repo = repos[0];
  if (!repo) return { repo: null, scanId: null, findings: [] };
  const scanId = repo.baseline_scan_id ?? (await db.selectFrom("scans").select("id").where("repo_id", "=", repo.id).where("kind", "=", "full").where("status", "=", "completed").orderBy("created_at", "desc").executeTakeFirst())?.id;
  if (!scanId) return SiteFindingsResponse.parse({ repo: repo.full_name, scanId: null, findings: [] });
  const rows = await db.selectFrom("findings").selectAll().where("scan_id", "=", scanId).where("status", "=", "verified").where("selector_hint", "is not", null).limit(500).execute();
  return SiteFindingsResponse.parse({
    repo: repo.full_name, scanId,
    findings: rows.map((f) => ({ fingerprint: f.fingerprint, sc: f.sc, severity: f.severity, path: f.path, line: f.line, message: f.message, selectorHint: f.selector_hint, url: understandingUrl(f.sc as WcagSc) })),
  });
});

await listen(app, env.PORT);
