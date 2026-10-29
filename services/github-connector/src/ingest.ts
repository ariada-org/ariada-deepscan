import { sql, type Selectable } from "kysely";
import type { Db, DB } from "@deepscan/platform";
import { counter } from "@deepscan/platform";
import type { Logger as FastifyBaseLogger } from "@deepscan/platform";
import { env } from "./env.js";
import { sourceFor, isScannable } from "./sources.js";

type RepoRow = Selectable<DB["repos"]>;
const scansCreated = counter("connector_scans_created_total", "Scans created, by kind and trigger");

export async function ensureRepo(
  db: Db,
  r: { fullName: string; source: RepoRow["source"]; githubId?: number | null; installationId?: number | null; defaultBranch?: string; siteUrl?: string | null },
): Promise<RepoRow> {
  return db
    .insertInto("repos")
    .values({
      full_name: r.fullName, source: r.source, github_id: r.githubId ?? null, installation_id: r.installationId ?? null,
      default_branch: r.defaultBranch ?? "main", site_url: r.siteUrl ?? null, baseline_scan_id: null,
    })
    .onConflict((oc) =>
      oc.column("full_name").doUpdateSet((eb) => ({
        source: eb.ref("excluded.source"),
        github_id: sql`coalesce(excluded.github_id, repos.github_id)`,
        installation_id: r.installationId === undefined ? eb.ref("repos.installation_id") : eb.ref("excluded.installation_id"),
        default_branch: r.defaultBranch ? eb.ref("excluded.default_branch") : eb.ref("repos.default_branch"),
        site_url: sql`coalesce(excluded.site_url, repos.site_url)`,
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface NewScan {
  repo: RepoRow;
  kind: "full" | "pr";
  ref: string;
  trigger: string;
  headSha?: string;
  baseSha?: string | null;
  baseScanId?: string | null;
  prNumber?: number | null;
  checkRunId?: number | null;
}

export async function createScan(db: Db, s: NewScan): Promise<string> {
  const headSha = s.headSha ?? (await sourceFor(s.repo).resolve(s.ref));
  const row = await db
    .insertInto("scans")
    .values({
      repo_id: s.repo.id, kind: s.kind, ref: s.ref, head_sha: headSha, base_sha: s.baseSha ?? null,
      base_scan_id: s.baseScanId ?? null, pr_number: s.prNumber ?? null, check_run_id: s.checkRunId ?? null,
      trigger: s.trigger, error: null, started_at: null, finished_at: null, published_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  scansCreated.inc({ kind: s.kind, trigger: s.trigger });
  return row.id;
}

/** Snapshot the tree and enqueue one job per scannable file. Idempotent (safe to re-run after a crash). */
export async function ingestScan(db: Db, scanId: string, log: FastifyBaseLogger): Promise<void> {
  const scan = await db.selectFrom("scans").selectAll().where("id", "=", scanId).executeTakeFirstOrThrow();
  const repo = await db.selectFrom("repos").selectAll().where("id", "=", scan.repo_id).executeTakeFirstOrThrow();
  try {
    const src = sourceFor(repo);
    const { entries, truncated } = await src.tree(scan.head_sha);
    let changed: Set<string> | null = null;
    if (scan.kind === "pr" && scan.pr_number) changed = new Set((await src.prFiles(scan.pr_number)).map((f) => f.path));
    const files = entries.slice(0, 20_000).map((e) => ({
      scan_id: scanId, path: e.path, blob_sha: e.sha, size: e.size,
      to_analyze: isScannable(e.path, e.size) && (!changed || changed.has(e.path)),
    }));
    let analyze = files.filter((f) => f.to_analyze);
    if (analyze.length > env.MAX_FILES_PER_SCAN) {
      const keep = new Set(analyze.slice(0, env.MAX_FILES_PER_SCAN).map((f) => f.path));
      for (const f of files) f.to_analyze = keep.has(f.path);
      analyze = analyze.slice(0, env.MAX_FILES_PER_SCAN);
    }
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom("scan_jobs").where("scan_id", "=", scanId).execute();
      await tx.deleteFrom("scan_files").where("scan_id", "=", scanId).execute();
      for (let i = 0; i < files.length; i += 500) await tx.insertInto("scan_files").values(files.slice(i, i + 500)).execute();
      for (let i = 0; i < analyze.length; i += 500)
        await tx.insertInto("scan_jobs").values(analyze.slice(i, i + 500).map((f) => ({ scan_id: scanId, path: f.path, locked_by: null, locked_until: null, started_at: null, finished_at: null, duration_ms: null, error: null }))).execute();
      await tx
        .updateTable("scans")
        .set({
          status: analyze.length ? "queued" : "completed",
          started_at: new Date(),
          finished_at: analyze.length ? null : new Date(),
          error: truncated ? "tree truncated by GitHub (very large repository); scanned the returned part" : null,
        })
        .where("id", "=", scanId)
        .execute();
    });
    log.info({ scanId, repo: repo.full_name, files: files.length, jobs: analyze.length, kind: scan.kind }, "scan ingested");
  } catch (e) {
    log.error({ scanId, err: (e as Error).message }, "ingest failed");
    await db.updateTable("scans").set({ status: "failed", error: `ingest: ${(e as Error).message}`.slice(0, 500), finished_at: new Date() }).where("id", "=", scanId).execute();
  }
}

export async function startScan(db: Db, s: NewScan, log: FastifyBaseLogger, wait = false): Promise<string> {
  const id = await createScan(db, s);
  const p = ingestScan(db, id, log);
  if (wait) await p;
  else void p;
  return id;
}

/** Recover scans whose ingesting pod died. */
export async function reclaimStaleIngests(db: Db, log: FastifyBaseLogger) {
  const stale = await db
    .updateTable("scans")
    .set({ created_at: new Date() })
    .where("status", "=", "ingesting")
    .where("created_at", "<", sql<Date>`now() - interval '3 minutes'`)
    .returning("id")
    .execute();
  for (const s of stale) {
    log.warn({ scanId: s.id }, "re-ingesting stale scan");
    await ingestScan(db, s.id, log);
  }
}
