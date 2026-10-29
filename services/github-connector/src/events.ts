/** Event worker: processes persisted webhook deliveries (competing consumers, SKIP LOCKED). */
import { sql } from "kysely";
import type { Logger as FastifyBaseLogger } from "@deepscan/platform";
import type { Db } from "@deepscan/platform";
import { counter } from "@deepscan/platform";
import { InstallationEvent, InstallationReposEvent, PullRequestEvent, PushEvent, IssueCommentEvent, Fingerprint } from "@deepscan/contracts";
import { env, appConfigured } from "./env.js";
import { gh, installationToken } from "./github/client.js";
import { GhRepo, GhPull, GhCheckRun, GhAny } from "./github/schemas.js";
import { ensureRepo, startScan, reclaimStaleIngests } from "./ingest.js";

const processed = counter("connector_events_processed_total", "Webhook events processed, by event and outcome");

async function upsertInstalledRepo(db: Db, installationId: number, fullName: string) {
  const token = await installationToken(installationId);
  const r = await gh({ path: `/repos/${fullName}`, schema: GhRepo, token });
  return ensureRepo(db, { fullName: r.full_name, source: "github-app", githubId: r.id, installationId, defaultBranch: r.default_branch, siteUrl: r.homepage || null });
}

async function fullScanOfDefaultBranch(db: Db, log: FastifyBaseLogger, installationId: number, fullName: string, trigger: string) {
  const repo = await upsertInstalledRepo(db, installationId, fullName);
  await startScan(db, { repo, kind: "full", ref: repo.default_branch, trigger }, log, true);
}

export async function startPrScan(db: Db, log: FastifyBaseLogger, installationId: number, fullName: string, pr: { number: number; head: { sha: string; ref: string }; base: { sha: string; ref: string } }, trigger: string) {
  const repo = await upsertInstalledRepo(db, installationId, fullName);
  // compare against a scan of the exact base commit
  let base = await db
    .selectFrom("scans").select("id").where("repo_id", "=", repo.id).where("kind", "=", "full")
    .where("head_sha", "=", pr.base.sha).where("status", "!=", "failed").orderBy("created_at", "desc").executeTakeFirst();
  if (!base) base = { id: await startScan(db, { repo, kind: "full", ref: pr.base.ref, headSha: pr.base.sha, trigger: "pr-base" }, log, true) };
  const token = await installationToken(installationId);
  const scanId = await startScan(db, { repo, kind: "pr", ref: pr.head.ref, headSha: pr.head.sha, baseSha: pr.base.sha, baseScanId: base.id, prNumber: pr.number, trigger }, log, true);
  const check = await gh({
    path: `/repos/${fullName}/check-runs`, method: "POST", token, schema: GhCheckRun,
    body: {
      name: "Ariada DeepScan", head_sha: pr.head.sha, status: "in_progress", external_id: scanId,
      details_url: `${env.PUBLIC_URL}/#/scans/${scanId}`,
      output: { title: "Deep accessibility scan in progress", summary: `Analysing changed files of PR #${pr.number} with the AI agent + deterministic verifier.` },
    },
  });
  await db.updateTable("scans").set({ check_run_id: check.id }).where("id", "=", scanId).execute();
}

async function handle(db: Db, log: FastifyBaseLogger, event: string, payload: unknown): Promise<"done" | "ignored"> {
  if (!appConfigured) return "ignored";
  switch (event) {
    case "ping":
      return "done";
    case "installation": {
      const e = InstallationEvent.parse(payload);
      if (e.action === "deleted" || e.action === "suspend") {
        await db.updateTable("repos").set({ installation_id: null }).where("installation_id", "=", e.installation.id).execute();
        await db.deleteFrom("installations").where("id", "=", e.installation.id).execute();
        return "done";
      }
      await db.insertInto("installations").values({ id: e.installation.id, account_login: e.installation.account.login })
        .onConflict((oc) => oc.column("id").doUpdateSet({ account_login: e.installation.account.login, suspended: false })).execute();
      if (e.action === "created") for (const r of e.repositories ?? []) await fullScanOfDefaultBranch(db, log, e.installation.id, r.full_name, "install");
      return "done";
    }
    case "installation_repositories": {
      const e = InstallationReposEvent.parse(payload);
      for (const r of e.repositories_removed) await db.updateTable("repos").set({ installation_id: null }).where("full_name", "=", r.full_name).execute();
      for (const r of e.repositories_added) await fullScanOfDefaultBranch(db, log, e.installation.id, r.full_name, "install");
      return "done";
    }
    case "pull_request": {
      const e = PullRequestEvent.parse(payload);
      if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(e.action)) return "ignored";
      await startPrScan(db, log, e.installation.id, e.repository.full_name, { number: e.number, ...e.pull_request }, `pull_request.${e.action}`);
      return "done";
    }
    case "push": {
      const e = PushEvent.parse(payload);
      const branch = e.ref.replace(/^refs\/heads\//, "");
      if (branch !== e.repository.default_branch || /^0+$/.test(e.after)) return "ignored";
      const repo = await upsertInstalledRepo(db, e.installation.id, e.repository.full_name);
      await startScan(db, { repo, kind: "full", ref: branch, headSha: e.after, trigger: "push" }, log, true);
      return "done";
    }
    case "issue_comment": {
      const e = IssueCommentEvent.parse(payload);
      if (e.action !== "created" || !e.issue.pull_request || e.comment.user.type === "Bot") return "ignored";
      const m = new RegExp(`@${env.BOT_NAME}\\s+(rescan|ignore)\\b\\s*([a-f0-9]{16})?\\s*(.*)`, "i").exec(e.comment.body);
      if (!m) return "ignored";
      const token = await installationToken(e.installation.id);
      const reply = (body: string) => gh({ path: `/repos/${e.repository.full_name}/issues/${e.issue.number}/comments`, method: "POST", token, body: { body }, schema: GhAny });
      if (m[1]!.toLowerCase() === "rescan") {
        const pr = await gh({ path: `/repos/${e.repository.full_name}/pulls/${e.issue.number}`, schema: GhPull, token });
        await startPrScan(db, log, e.installation.id, e.repository.full_name, pr, "comment.rescan");
        await reply(`🔁 Re-scan started by @${e.comment.user.login}.`);
      } else {
        const fp = Fingerprint.safeParse(m[2]);
        if (!fp.success) {
          await reply("Usage: `@" + env.BOT_NAME + " ignore <fingerprint> <reason>`");
          return "done";
        }
        const repo = await upsertInstalledRepo(db, e.installation.id, e.repository.full_name);
        await db.insertInto("exemptions").values({ repo_id: repo.id, fingerprint: fp.data, created_by: e.comment.user.login, reason: m[3]?.slice(0, 300) || null })
          .onConflict((oc) => oc.columns(["repo_id", "fingerprint"]).doNothing()).execute();
        await reply(`✅ Finding \`${fp.data}\` exempted by @${e.comment.user.login}. It will no longer block this repository.`);
      }
      return "done";
    }
  }
  return "ignored";
}

export function startEventWorker(db: Db, log: FastifyBaseLogger, intervalMs = 1500) {
  let stopped = false;
  let ticks = 0;
  const loop = async () => {
    while (!stopped) {
      try {
        if (++ticks % 40 === 0) await reclaimStaleIngests(db, log);
        const job = await db.transaction().execute(async (tx) => {
          const row = await sql<{ id: string; event: string; payload: unknown; attempts: number }>`
            SELECT id, event, payload, attempts FROM webhook_deliveries
            WHERE status IN ('pending','processing') AND (locked_until IS NULL OR locked_until < now()) AND attempts < 5
            ORDER BY received_at LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(tx);
          const r = row.rows[0];
          if (!r) return null;
          await tx.updateTable("webhook_deliveries").set({ status: "processing", attempts: r.attempts + 1, locked_until: sql<Date>`now() + interval '2 minutes'` }).where("id", "=", r.id).execute();
          return r;
        });
        if (!job) {
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        try {
          const outcome = await handle(db, log, job.event, job.payload);
          await db.updateTable("webhook_deliveries").set({ status: outcome, error: null, locked_until: null }).where("id", "=", job.id).execute();
          processed.inc({ event: job.event, outcome });
          log.info({ delivery: job.id, event: job.event, outcome }, "webhook processed");
        } catch (e) {
          const err = (e as Error).message.slice(0, 500);
          await db.updateTable("webhook_deliveries").set({ status: job.attempts + 1 >= 5 ? "error" : "pending", error: err, locked_until: sql<Date>`now() + interval '30 seconds'` }).where("id", "=", job.id).execute();
          processed.inc({ event: job.event, outcome: "error" });
          log.error({ delivery: job.id, event: job.event, err }, "webhook processing failed");
        }
      } catch (e) {
        log.error({ err: (e as Error).message }, "event worker error");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
