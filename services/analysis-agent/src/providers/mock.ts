/**
 * Deterministic stand-in for an LLM so the whole system can be run and graded
 * without an API key. It behaves like a tool-calling agent (searches the RAG,
 * runs the rules, reports findings) and *deliberately* exhibits the failure
 * modes the architecture defends against:
 *   - an invented WCAG criterion  → rejected by the type-safe layer (repair loop)
 *   - a fabricated snippet        → rejected by the verifier (hallucination)
 *   - a claim contradicted by code → rejected by the verifier (deterministic re-check)
 *   - semantic, ungroundable issue → "unverifiable" (human review)
 */
import { createHash } from "node:crypto";
import type { LlmProvider, CompletionRequest, Completion, ToolCall } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "scripted-agent-v1";
  constructor(private delayMs: number, private hallucinateRate: number) {}

  async complete(req: CompletionRequest): Promise<Completion> {
    const f = req.file ?? { path: "unknown", content: "" };
    const h = parseInt(createHash("sha1").update(f.path + f.content).digest("hex").slice(0, 8), 16);
    await sleep(Math.round(this.delayMs * (0.7 + ((h % 61) / 100))));
    const turn = req.messages.filter((m) => m.role === "assistant").length;
    let n = 0;
    const call = (name: string, args: unknown): ToolCall => ({ id: `mock_${turn}_${n++}`, name, args });

    if (turn === 0) {
      const ext = f.path.split(".").pop();
      const q = ext === "css" || ext === "scss" ? "colour contrast and visible focus indicator in CSS" : "accessible names for interactive elements and images";
      return { text: "I'll run the deterministic rules first and look up the relevant WCAG guidance.", toolCalls: [call("run_rules", {}), call("search_wcag", { query: q, k: 3 }), call("list_related", {})] };
    }

    if (turn === 1) {
      const calls: ToolCall[] = [];
      const lines = f.content.split("\n");
      const at = (re: RegExp) => {
        for (let i = 0; i < lines.length; i++) {
          const m = re.exec(lines[i]!);
          if (m) return { line: i + 1, snippet: m[0] };
        }
        return null;
      };
      const icon = at(/<button\b[^>]*>(?=\s*(<i\b|<svg\b|$))/);
      if (icon) {
        calls.push(call("search_wcag", { query: "icon-only button accessible name aria-label", k: 3 }));
        calls.push(call("report_finding", { ruleId: null, sc: "4.1.2", severity: "critical", line: icon.line, snippet: icon.snippet, message: "Icon-only button has no accessible name; screen readers announce just 'button'.", suggestion: 'Add aria-label="Close" (or the action) and aria-hidden="true" on the icon.' }));
      }
      const err = at(/<[a-z]+\b[^>]*class(Name)?="[^"]*\berror\b[^"]*"[^>]*>/);
      if (err) {
        calls.push(call("search_wcag", { query: "error identified only by colour", k: 2 }));
        calls.push(call("report_finding", { ruleId: null, sc: "1.4.1", severity: "moderate", line: err.line, snippet: err.snippet, message: "The error state seems to be communicated by red colour only, with no icon or text prefix.", suggestion: "Prefix the message with an icon or the word 'Error:' and associate it with the field via aria-describedby." }));
      }
      const ph = at(/<input\b[^>]*placeholder="[^"]*"[^>]*>/);
      if (ph) calls.push(call("report_finding", { ruleId: null, sc: "3.3.2", severity: "serious", line: ph.line, snippet: ph.snippet, message: "Field relies on placeholder text as its only instruction; it disappears while typing.", suggestion: "Add a persistent visible <label>." }));
      const labelled = /<label\b[^>]*(for|htmlFor)="([^"]+)"/.exec(f.content);
      const target = labelled ? at(new RegExp(`<(input|textarea|select)\\b[^>]*id="${labelled[2]}"[^>]*>`)) : null;
      if (target) calls.push(call("report_finding", { ruleId: null, sc: "4.1.2", severity: "serious", line: target.line, snippet: target.snippet, message: "This form field is missing a label.", suggestion: null }));
      if ((h % 1000) / 1000 < this.hallucinateRate && /\.(html|tsx|jsx|vue|svelte)$/.test(f.path))
        calls.push(call("report_finding", { ruleId: null, sc: "1.1.1", severity: "critical", line: 3, snippet: '<img src="assets/banner.png">', message: "Banner image has no alt attribute.", suggestion: 'Add alt="…".' }));
      if (h % 5 === 1) calls.push(call("report_finding", { ruleId: null, sc: "2.4.14", severity: "minor", line: 1, snippet: lines[0] ?? "x", message: "Navigation landmarks are not consistent.", suggestion: null }));
      if (calls.length === 0) return { text: "Nothing beyond the deterministic findings.", toolCalls: [call("finish", { summary: "No additional semantic issues found." })] };
      return { text: "Reporting issues that need semantic judgement.", toolCalls: calls };
    }

    const last = req.messages[req.messages.length - 1];
    const schemaError = last?.role === "tool" && last.results.some((r) => r.isError && r.content.includes("schema violation"));
    if (schemaError && turn === 2) {
      // repair: the type-safe layer told us 2.4.14 does not exist
      return { text: "Correcting the criterion.", toolCalls: [call("report_finding", { ruleId: null, sc: "3.2.3", severity: "minor", line: 1, snippet: f.content.split("\n")[0] ?? "x", message: "Navigation may not be in a consistent order across pages.", suggestion: null }), call("finish", { summary: "done" })] };
    }
    return { text: "Done.", toolCalls: [call("finish", { summary: "Analysis complete." })] };
  }
}
