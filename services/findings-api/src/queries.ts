import { sql, type Selectable } from "kysely";
import type { z } from "zod";
import type { Db, DB, Session } from "@deepscan/platform";
import { FindingRecord, ScanSummary, type DiffClass } from "@deepscan/contracts";

type RepoRow = Selectable<DB["repos"]>;

export function canSee(repo: Pick<RepoRow, "source" | "installation_id">, s: Session | null): boolean {
  if (repo.source === "fixture" || repo.source === "public") return true;
  return !!(s && repo.installation_id && s.installationIds.includes(repo.installation_id));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function scanSummary(db: Db, id: string): Promise<{ summary: z.output<typeof ScanSummary>; repo: RepoRow } | null> {
  const s = await db.selectFrom("scans").selectAll().where("id", "=", id).executeTakeFirst();
  if (!s) return null;
  const repo = await db.selectFrom("repos").selectAll().where("id", "=", s.repo_id).executeTakeFirstOrThrow();
  const summary = ScanSummary.parse({
    id: s.id, repoId: s.repo_id, repoFullName: repo.full_name, kind: s.kind, status: s.status, ref: s.ref, headSha: s.head_sha,
    baseScanId: s.base_scan_id, prNumber: s.pr_number, createdAt: s.created_at.toISOString(), finishedAt: iso(s.finished_at),
  });
  return { summary, repo };
}

type FRow = Selectable<DB["findings"]>;
export function toRecord(f: FRow): z.output<typeof FindingRecord> {
  return FindingRecord.parse({
    id: f.id, ruleId: f.rule_id, sc: f.sc, severity: f.severity, path: f.path, line: f.line, snippet: f.snippet, message: f.message,
    suggestion: f.suggestion, source: f.source, status: f.status, method: f.method, reason: f.reason, fingerprint: f.fingerprint,
    selectorHint: f.selector_hint, workerPod: f.worker_pod,
  });
}

/**
 * Version diff: classify findings of `head` against `base` by fingerprint.
 * Only files analysed in `head` are compared (a PR scan analyses changed files only).
 */
export async function diffScans(db: Db, base: string, head: string) {
  const h = await db.selectFrom("findings").selectAll().where("scan_id", "=", head).where("status", "<>", "rejected").where("fingerprint", "is not", null).execute();
  const b = await db.selectFrom("findings").selectAll().where("scan_id", "=", base).where("status", "<>", "rejected").where("fingerprint", "is not", null)
    .where("path", "in", sql<string>`(SELECT path FROM scan_jobs WHERE scan_id = ${head})`).execute();
  const baseFp = new Set(b.map((f) => f.fingerprint));
  const headFp = new Set(h.map((f) => f.fingerprint));
  const items: (z.output<typeof FindingRecord> & { diff: z.output<typeof DiffClass> })[] = [
    ...h.map((f) => ({ ...toRecord(f), diff: baseFp.has(f.fingerprint) ? ("persistent" as const) : ("regression" as const) })),
    ...b.filter((f) => !headFp.has(f.fingerprint)).map((f) => ({ ...toRecord(f), diff: "resolved" as const })),
  ];
  const counts = { regression: 0, resolved: 0, persistent: 0 };
  for (const i of items) counts[i.diff]++;
  return { base, head, counts, items };
}
