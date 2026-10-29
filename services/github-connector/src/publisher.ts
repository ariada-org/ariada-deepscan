/**
 * Publisher: when a scan completes, (a) promote default-branch scans to the
 * repository baseline, (b) for PR scans compute the regression diff
 * against the base-commit scan (via findings-api), evaluate the policy
 * gate (verifier) and report back to GitHub as a Check Run with annotations,
 * inline review comments and a summary comment.
 */
import { sql } from "kysely";
import type { Logger as FastifyBaseLogger } from "@deepscan/platform";
import type { Db } from "@deepscan/platform";
import { callJson, counter } from "@deepscan/platform";
import { DiffResponse, PolicyEvaluateResponse } from "@deepscan/contracts";
import { env, appConfigured } from "./env.js";
import { gh, installationToken } from "./github/client.js";
import { GhAny, GhIssueComments } from "./github/schemas.js";
import { sourceFor } from "./sources.js";
import { inlineComment, summaryComment, SUMMARY_MARKER, commentableLines, safeText, title, type PubFinding } from "./render.js";

const published = counter("connector_published_total", "Scans published, by kind and conclusion");

async function publishPr(db: Db, log: FastifyBaseLogger, scanId: string): Promise<boolean> {
  const scan = await db.selectFrom("scans").selectAll().where("id", "=", scanId).executeTakeFirstOrThrow();
  const repo = await db.selectFrom("repos").selectAll().where("id", "=", scan.repo_id).executeTakeFirstOrThrow();
  const dashboardUrl = `${env.PUBLIC_URL}/#/scans/${scanId}`;
  let conclusion = "neutral";
  let titleLine = "";
  let summary = "";
  let regressions: PubFinding[] = [];

  if (scan.status === "failed") {
    titleLine = "Scan failed";
    summary = `The scan could not be completed: ${safeText(scan.error ?? "unknown error")}`;
  } else {
    if (!scan.base_scan_id) return true;
    const base = await db.selectFrom("scans").select(["status"]).where("id", "=", scan.base_scan_id).executeTakeFirst();
    if (base && !["completed", "failed"].includes(base.status)) return false; // wait for the base scan
    const diff = await callJson({ url: `${env.FINDINGS_API_URL}/internal/diff?base=${scan.base_scan_id}&head=${scanId}`, schema: DiffResponse });
    const exempt = new Set((await db.selectFrom("exemptions").select("fingerprint").where("repo_id", "=", repo.id).execute()).map((e) => e.fingerprint));
    const items = diff.items.filter((i) => !(i.fingerprint && exempt.has(i.fingerprint)));
    const policy = await callJson({
      url: `${env.VERIFIER_URL}/policy/evaluate`, schema: PolicyEvaluateResponse,
      body: { findings: items.map((i) => ({ severity: i.severity, status: i.status, diff: i.diff })) },
    });
    conclusion = policy.conclusion;
    titleLine = policy.title;
    summary = policy.summary + (exempt.size ? `\n${diff.items.length - items.length} finding(s) exempted.` : "");
    regressions = items.filter((i) => i.diff === "regression" && i.status !== "rejected");
  }

  if (!appConfigured || !repo.installation_id || !scan.pr_number) return true;
  const token = await installationToken(repo.installation_id);
  const full = repo.full_name;

  // 1) Check Run (annotations are attached in batches of 50)
  const ann = regressions.map((f) => ({
    path: f.path, start_line: f.line, end_line: f.line,
    annotation_level: f.status === "verified" && ["critical", "serious"].includes(f.severity) ? "failure" : f.status === "verified" ? "warning" : "notice",
    title: `${title(f.sc)} (${f.severity}${f.status === "verified" ? "" : ", needs review"})`.slice(0, 250),
    message: `${safeText(f.message, 600)}\nfingerprint ${f.fingerprint ?? "-"}`,
  }));
  if (scan.check_run_id) {
    for (let i = 0; i === 0 || i < ann.length; i += 50) {
      await gh({
        path: `/repos/${full}/check-runs/${scan.check_run_id}`, method: "PATCH", token, schema: GhAny,
        body: {
          ...(i === 0 ? { status: "completed", conclusion, completed_at: new Date().toISOString(), details_url: dashboardUrl } : {}),
          output: { title: titleLine.slice(0, 250), summary: summary.slice(0, 60_000), annotations: ann.slice(i, i + 50) },
        },
      });
    }
  }

  // 2) Inline review comments — only on lines that are part of the PR diff
  if (regressions.length) {
    try {
      const files = await sourceFor(repo).prFiles(scan.pr_number);
      const lines = new Map(files.map((f) => [f.path, commentableLines(f.patch)]));
      const comments = regressions
        .filter((f) => lines.get(f.path)?.has(f.line))
        .slice(0, 30)
        .map((f) => ({ path: f.path, line: f.line, side: "RIGHT", body: inlineComment(f) }));
      if (comments.length)
        await gh({ path: `/repos/${full}/pulls/${scan.pr_number}/reviews`, method: "POST", token, schema: GhAny, body: { commit_id: scan.head_sha, event: "COMMENT", body: `Ariada DeepScan found ${regressions.length} new accessibility issue(s).`, comments } });
    } catch (e) {
      log.warn({ scanId, err: (e as Error).message }, "review comments failed");
    }
  }

  // 3) Summary comment (create or update in place)
  const body = summaryComment({ conclusion, titleLine, summary, regressions, dashboardUrl });
  const existing = (await gh({ path: `/repos/${full}/issues/${scan.pr_number}/comments?per_page=100`, schema: GhIssueComments, token })).find((c) => c.user?.type === "Bot" && c.body?.includes(SUMMARY_MARKER));
  if (existing) await gh({ path: `/repos/${full}/issues/comments/${existing.id}`, method: "PATCH", token, schema: GhAny, body: { body } });
  else await gh({ path: `/repos/${full}/issues/${scan.pr_number}/comments`, method: "POST", token, schema: GhAny, body: { body } });
  published.inc({ kind: "pr", conclusion });
  log.info({ scanId, pr: scan.pr_number, conclusion, regressions: regressions.length }, "PR results published to GitHub");
  return true;
}

async function publishFull(db: Db, log: FastifyBaseLogger, scanId: string) {
  const scan = await db.selectFrom("scans").selectAll().where("id", "=", scanId).executeTakeFirstOrThrow();
  const repo = await db.selectFrom("repos").selectAll().where("id", "=", scan.repo_id).executeTakeFirstOrThrow();
  if (scan.status === "completed" && scan.ref === repo.default_branch && scan.trigger !== "pr-base") {
    await db.updateTable("repos").set({ baseline_scan_id: scanId }).where("id", "=", repo.id)
      .where((eb) => eb.or([eb("baseline_scan_id", "is", null), eb("baseline_scan_id", "in", eb.selectFrom("scans").select("id").where("created_at", "<", scan.created_at))]))
      .execute();
    log.info({ scanId, repo: repo.full_name }, "baseline updated");
  }
  published.inc({ kind: "full", conclusion: scan.status });
}

export function startPublisher(db: Db, log: FastifyBaseLogger, intervalMs = 2000) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const claimed = await db.transaction().execute(async (tx) => {
          const r = await sql<{ id: string; kind: string }>`
            SELECT id, kind FROM scans s WHERE status IN ('completed','failed') AND published_at IS NULL
              AND (kind = 'full' OR status = 'failed' OR base_scan_id IS NULL
                   OR EXISTS (SELECT 1 FROM scans b WHERE b.id = s.base_scan_id AND b.status IN ('completed','failed')))
            ORDER BY finished_at NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(tx);
          const s = r.rows[0];
          if (!s) return null;
          const done = s.kind === "pr" ? await publishPr(tx, log, s.id) : (await publishFull(tx, log, s.id), true);
          if (done) await tx.updateTable("scans").set({ published_at: new Date() }).where("id", "=", s.id).execute();
          return done ? s : null;
        });
        if (!claimed) await new Promise((r) => setTimeout(r, intervalMs));
      } catch (e) {
        log.error({ err: (e as Error).message }, "publisher error");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
