import { z } from "zod";
import type { App, Db } from "@deepscan/platform";
import { SESSION_COOKIE, sessionFromCookie } from "@deepscan/platform";
import { CreateScanRequest, CreateScanResponse, FileContentResponse, RelatedFilesResponse, ErrorResponse, RepoPath, ScanId, parseGithubUrl } from "@deepscan/contracts";
import { env, appConfigured, oauthConfigured } from "./env.js";
import { gh } from "./github/client.js";
import { GhRepo } from "./github/schemas.js";
import { ensureRepo, startScan } from "./ingest.js";
import { sourceFor } from "./sources.js";
import { relatedPaths } from "./related.js";

/** naive per-pod token bucket for anonymous public scans */
const buckets = new Map<string, { n: number; reset: number }>();
function allow(ip: string, limit = 5, windowMs = 10 * 60_000) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.reset < now) {
    buckets.set(ip, { n: 1, reset: now + windowMs });
    return true;
  }
  return ++b.n <= limit;
}

export function registerRoutes(app: App, db: Db) {
  app.get("/gh/config", { schema: { response: { 200: z.object({ appConfigured: z.boolean(), signInEnabled: z.boolean(), installUrl: z.string().nullable(), publicScans: z.boolean() }) } } }, async () => ({
    appConfigured,
    signInEnabled: oauthConfigured,
    installUrl: env.GITHUB_APP_SLUG ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : null,
    publicScans: env.ALLOW_PUBLIC_SCANS,
  }));

  app.post(
    "/gh/scans",
    { schema: { body: CreateScanRequest, response: { 202: CreateScanResponse, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse } } },
    async (req, reply) => {
      const session = await sessionFromCookie(db, req.cookies[SESSION_COOKIE]);
      const apiKeyOk = !!env.SCAN_API_KEY && req.headers["x-api-key"] === env.SCAN_API_KEY;
      let repo;
      if ("repoId" in req.body) {
        repo = await db.selectFrom("repos").selectAll().where("id", "=", req.body.repoId).executeTakeFirst();
        if (!repo) return reply.code(404).send({ error: "unknown repository" });
      } else {
        const full = parseGithubUrl(req.body.repoUrl);
        if (!full) return reply.code(400).send({ error: "only https://github.com/{owner}/{repo} URLs are accepted" });
        repo = await db.selectFrom("repos").selectAll().where("full_name", "=", full).executeTakeFirst();
        if (!repo) {
          const meta = await gh({ path: `/repos/${full}`, schema: GhRepo, token: env.GITHUB_TOKEN ?? null }).catch(() => null);
          if (!meta || meta.private) return reply.code(404).send({ error: "repository not found or not public (install the GitHub App for private repositories)" });
          repo = await ensureRepo(db, { fullName: meta.full_name, source: "public", githubId: meta.id, defaultBranch: meta.default_branch, siteUrl: meta.homepage || null });
        }
      }
      const viaInstallation = !!(session && repo.installation_id && session.installationIds.includes(repo.installation_id));
      const allowed = repo.source === "fixture" || apiKeyOk || viaInstallation || (repo.source === "public" && env.ALLOW_PUBLIC_SCANS);
      if (!allowed) return reply.code(403).send({ error: "not allowed to scan this repository" });
      if (!apiKeyOk && !viaInstallation && repo.source !== "fixture" && !allow(req.ip)) return reply.code(429).send({ error: "too many anonymous scans, try again later" });
      const ref = req.body.ref ?? repo.default_branch;
      const scanId = await startScan(db, { repo, kind: "full", ref, trigger: session ? `manual:${session.login}` : "manual" }, req.log);
      return reply.code(202).send({ scanId: ScanId.parse(scanId), repoId: repo.id as never, status: "ingesting" });
    },
  );

  /* ---- internal (cluster-only, not routed by the Ingress): tool back-end for the agent ---- */
  const scanFile = async (scanId: string, path: string) =>
    db.selectFrom("scan_files").selectAll().where("scan_id", "=", scanId).where("path", "=", path).executeTakeFirst();

  async function content(scanId: string, path: string): Promise<{ sha: string; size: number; content: string } | null> {
    const f = await scanFile(scanId, path);
    if (!f) return null;
    const cached = await db.selectFrom("blobs").select("content").where("sha", "=", f.blob_sha).executeTakeFirst();
    if (cached) return { sha: f.blob_sha, size: f.size, content: cached.content };
    const scan = await db.selectFrom("scans").selectAll().where("id", "=", scanId).executeTakeFirstOrThrow();
    const repo = await db.selectFrom("repos").selectAll().where("id", "=", scan.repo_id).executeTakeFirstOrThrow();
    const text = await sourceFor(repo).content({ path, sha: f.blob_sha }, scan.head_sha);
    await db.insertInto("blobs").values({ sha: f.blob_sha, content: text }).onConflict((oc) => oc.column("sha").doNothing()).execute();
    return { sha: f.blob_sha, size: f.size, content: text };
  }

  const fileQuery = { params: z.object({ scanId: ScanId }), querystring: z.object({ path: RepoPath }) };
  app.get("/internal/scans/:scanId/file", { schema: { ...fileQuery, response: { 200: FileContentResponse, 404: ErrorResponse } } }, async (req, reply) => {
    const c = await content(req.params.scanId, req.query.path);
    if (!c) return reply.code(404).send({ error: "path is not part of this scan snapshot" });
    if (c.size > env.MAX_FILE_BYTES) return reply.code(404).send({ error: "file too large" });
    return { path: req.query.path, ...c };
  });

  app.get("/internal/scans/:scanId/related", { schema: { ...fileQuery, response: { 200: RelatedFilesResponse, 404: ErrorResponse } } }, async (req, reply) => {
    const c = await content(req.params.scanId, req.query.path);
    if (!c) return reply.code(404).send({ error: "path is not part of this scan snapshot" });
    const all = new Set((await db.selectFrom("scan_files").select("path").where("scan_id", "=", req.params.scanId).execute()).map((r) => r.path));
    return { path: req.query.path, related: relatedPaths(req.query.path, c.content, (p) => all.has(p)).map((p) => RepoPath.parse(p)) };
  });
}
