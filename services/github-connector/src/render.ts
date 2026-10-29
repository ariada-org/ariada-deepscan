/**
 * Everything posted to GitHub is rendered from a fixed template. Text that
 * originated from the LLM is sanitised (no HTML, links or @-mentions) so a
 * prompt-injected model cannot make the bot post arbitrary content.
 */
import { scInfo, type WcagSc } from "@deepscan/contracts";

export function safeText(s: string, max = 300): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))
    .replace(/@(?=\w)/g, "@​")
    .replace(/[`*_~|]/g, (c) => "\\" + c)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export interface PubFinding {
  sc: string;
  severity: string;
  status: string;
  path: string;
  line: number;
  message: string;
  fingerprint: string | null;
  diff?: string;
  ruleId?: string | null;
}

export function title(sc: string): string {
  try {
    return `WCAG ${sc} ${scInfo(sc as WcagSc).title}`;
  } catch {
    return `WCAG ${sc}`;
  }
}

const badge = (f: PubFinding) => (f.status === "verified" ? "✅ verified" : "🧑‍⚖️ needs review");

export function inlineComment(f: PubFinding): string {
  return [
    `**${title(f.sc)}** · ${f.severity} · ${badge(f)}`,
    "",
    safeText(f.message, 500),
    "",
    `<sub>Ariada DeepScan · fingerprint \`${f.fingerprint ?? "-"}\` · reply \`@ariada-deepscan ignore ${f.fingerprint ?? "<fp>"} <reason>\` to exempt</sub>`,
  ].join("\n");
}

export const SUMMARY_MARKER = "<!-- ariada-deepscan-summary -->";

export function summaryComment(o: { conclusion: string; titleLine: string; summary: string; regressions: PubFinding[]; dashboardUrl: string }): string {
  const icon = o.conclusion === "success" ? "🟢" : o.conclusion === "failure" ? "🔴" : "🟡";
  const rows = o.regressions.slice(0, 25).map((f) => `| ${f.status === "verified" ? "✅" : "🧑‍⚖️"} | ${f.severity} | ${title(f.sc)} | \`${safeText(f.path, 120)}:${f.line}\` | ${safeText(f.message, 140)} |`);
  return [
    SUMMARY_MARKER,
    `## ${icon} Ariada DeepScan — ${safeText(o.titleLine, 120)}`,
    "",
    o.summary,
    "",
    ...(rows.length ? ["| | Severity | Criterion | Location | Issue |", "|---|---|---|---|---|", ...rows, ""] : []),
    o.regressions.length > 25 ? `…and ${o.regressions.length - 25} more.\n` : "",
    `Only **new** issues introduced by this PR can block it; every AI finding is re-checked by a deterministic verifier (✅) or marked for human review (🧑‍⚖️).`,
    "",
    `[Open the full scan in the dashboard](${o.dashboardUrl})`,
  ].join("\n");
}

/** RIGHT-side line numbers that are part of a unified-diff hunk (commentable). */
export function commentableLines(patch: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!patch) return out;
  let n = 0;
  for (const l of patch.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (l.startsWith("-")) continue;
    if (l.startsWith("+") || l.startsWith(" ")) out.add(n++);
  }
  return out;
}
