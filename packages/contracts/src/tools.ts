/**
 * Tool contracts for the analysis agent. One Zod schema per tool is the single
 * source of truth for (a) the JSON Schema sent to the LLM as the tool
 * definition and (b) runtime validation of the arguments the LLM returns.
 * Arguments that fail validation are returned to the model as a tool error
 * (repair loop) — they never reach a service.
 */
import { z } from "zod";
import { WcagSc } from "./wcag.js";
import { RepoPath } from "./ids.js";
import { CandidateFinding } from "./findings.js";

export const SearchWcagInput = z.object({
  query: z.string().min(3).max(200).describe("What you need to know, e.g. 'accessible name for icon-only button'"),
  k: z.number().int().min(1).max(8).default(4),
});
export const GetScInput = z.object({ sc: WcagSc });
export const ReadFileInput = z.object({
  path: RepoPath.describe("Repository-relative path of a file in the current scan"),
});
export const ListRelatedInput = z.object({
  path: RepoPath.optional().describe("Defaults to the file under analysis"),
});
export const RunRulesInput = z.object({});
export const ReportFindingInput = CandidateFinding.omit({ source: true, path: true });
export const FinishInput = z.object({ summary: z.string().max(500) });

export const AGENT_TOOLS = {
  search_wcag: {
    description: "Search the built-in WCAG 2.2 knowledge base (success criteria, Understanding docs, Techniques, Failures, ARIA patterns). Use it to ground every finding.",
    input: SearchWcagInput,
  },
  get_sc: {
    description: "Get the title, level, applicability and summary of one WCAG 2.2 success criterion.",
    input: GetScInput,
  },
  read_file: {
    description: "Read another file from the same repository snapshot (read-only, only paths in the scanned tree).",
    input: ReadFileInput,
  },
  list_related: {
    description: "List files referenced by a file (imports, stylesheets, scripts) that exist in the scanned tree.",
    input: ListRelatedInput,
  },
  run_rules: {
    description: "Run the deterministic rules engine on the file under analysis and get its findings (tier 1).",
    input: RunRulesInput,
  },
  report_finding: {
    description: "Report ONE accessibility violation in the file under analysis. `snippet` must be copied verbatim from the file. Findings are independently verified; fabricated snippets are rejected.",
    input: ReportFindingInput,
  },
  finish: {
    description: "Call when the analysis of the file is complete.",
    input: FinishInput,
  },
} as const;

export type AgentToolName = keyof typeof AGENT_TOOLS;
export type AgentToolInput<N extends AgentToolName> = z.output<(typeof AGENT_TOOLS)[N]["input"]>;

export interface ToolDefinition {
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** JSON Schema tool definitions generated from the Zod contracts. */
export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(AGENT_TOOLS) as AgentToolName[]).map((name) => {
    const schema = z.toJSONSchema(AGENT_TOOLS[name].input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema["$schema"];
    return { name, description: AGENT_TOOLS[name].description, inputSchema: schema };
  });
}

export type ParsedToolCall =
  | { ok: true; name: AgentToolName; args: unknown }
  | { ok: false; name: string; error: string };

/** Validate a raw tool call coming back from the LLM. */
export function parseToolCall(name: string, rawArgs: unknown): ParsedToolCall {
  if (!(name in AGENT_TOOLS)) return { ok: false, name, error: `unknown tool '${name}'` };
  const tool = AGENT_TOOLS[name as AgentToolName];
  const r = tool.input.safeParse(rawArgs ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, name, error: `schema violation: ${msg}` };
  }
  return { ok: true, name: name as AgentToolName, args: r.data };
}
