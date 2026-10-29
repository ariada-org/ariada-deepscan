/** Tool executors — each one is a typed REST call to another microservice. */
import { callJson, counter } from "@deepscan/platform";
import {
  type AgentToolName, type CandidateFinding, type RepoPath, type ScanId,
  SearchResponse, ScDetail, FileContentResponse, RelatedFilesResponse, RulesRunResponse,
  SearchWcagInput, GetScInput, ReadFileInput, ListRelatedInput, ReportFindingInput,
} from "@deepscan/contracts";
import type { z } from "zod";
import { env } from "./env.js";

export const toolCalls = counter("agent_tool_calls_total", "Tool calls executed by the agent, by tool and outcome");

export interface ToolCtx {
  scanId: ScanId | null;
  path: RepoPath;
  content: string;
  reported: CandidateFinding[];
  rules: CandidateFinding[];
  finished: boolean;
}

const cap = (s: string, n = 6000) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);
export const numbered = (s: string, max: number) =>
  s.split("\n").slice(0, max).map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");

/** Models sometimes copy the line-number gutter into the snippet — strip it deterministically. */
export function cleanSnippet(s: string): string {
  return s.split("\n").map((l) => l.replace(/^\s*\d+\| ?/, "")).join("\n");
}

export async function execute(name: AgentToolName, args: unknown, ctx: ToolCtx): Promise<string> {
  switch (name) {
    case "search_wcag": {
      const a = args as z.output<typeof SearchWcagInput>;
      const r = await callJson({ url: `${env.RAG_URL}/search`, body: a, schema: SearchResponse });
      return JSON.stringify(r.hits.map((h) => ({ id: h.id, sc: h.sc, title: h.title, text: h.text, url: h.url })));
    }
    case "get_sc": {
      const a = args as z.output<typeof GetScInput>;
      return JSON.stringify(await callJson({ url: `${env.RAG_URL}/sc/${a.sc}`, schema: ScDetail }));
    }
    case "read_file": {
      const a = args as z.output<typeof ReadFileInput>;
      if (!ctx.scanId) return JSON.stringify({ error: "no repository context" });
      const r = await callJson({ url: `${env.CONNECTOR_URL}/internal/scans/${ctx.scanId}/file?path=${encodeURIComponent(a.path)}`, schema: FileContentResponse, retries: 1 });
      return cap(`${r.path}\n${numbered(r.content, 400)}`, 12_000);
    }
    case "list_related": {
      const a = args as z.output<typeof ListRelatedInput>;
      if (!ctx.scanId) return "[]";
      const r = await callJson({ url: `${env.CONNECTOR_URL}/internal/scans/${ctx.scanId}/related?path=${encodeURIComponent(a.path ?? ctx.path)}`, schema: RelatedFilesResponse, retries: 1 });
      return JSON.stringify(r.related);
    }
    case "run_rules":
      return JSON.stringify(ctx.rules.map((c) => ({ ruleId: c.ruleId, sc: c.sc, line: c.line, snippet: c.snippet, message: c.message })));
    case "report_finding": {
      const a = args as z.output<typeof ReportFindingInput>;
      ctx.reported.push({ ...a, snippet: cleanSnippet(a.snippet), path: ctx.path, source: "llm" });
      return JSON.stringify({ accepted: true, note: "queued for independent verification" });
    }
    case "finish":
      ctx.finished = true;
      return JSON.stringify({ ok: true });
  }
}

export async function runRules(path: RepoPath, content: string): Promise<CandidateFinding[]> {
  return (await callJson({ url: `${env.VERIFIER_URL}/rules/run`, body: { path, content }, schema: RulesRunResponse })).candidates;
}
