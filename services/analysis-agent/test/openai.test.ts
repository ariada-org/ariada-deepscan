import { describe, expect, it } from "vitest";
import { toolCallsFromText } from "../src/providers/openai.js";

const known = new Set(["search_wcag", "report_finding", "finish"]);

describe("tool calls written as text", () => {
  it("reads one JSON object per line, as qwen2.5-coder through Ollama answers", () => {
    // verbatim shape of a real reply from qwen2.5-coder:7b on Ollama 0.20.7
    const text = [
      '{"name": "search_wcag", "arguments": {"query": "accessible name for icon-only button"}}',
      '{"name": "report_finding", "arguments": {"sc": "1.1.1", "line": 7, "snippet": "<img {src} {alt} />", "message": "brace } in a string"}}',
      '{"name": "finish", "arguments": {"summary": "done"}}',
    ].join("\n");
    expect(toolCallsFromText(text, known)).toEqual([
      { name: "search_wcag", args: { query: "accessible name for icon-only button" } },
      { name: "report_finding", args: { sc: "1.1.1", line: 7, snippet: "<img {src} {alt} />", message: "brace } in a string" } },
      { name: "finish", args: { summary: "done" } },
    ]);
  });

  it("accepts fenced blocks and string-encoded arguments", () => {
    const text = 'Calling a tool:\n```json\n{"name": "finish", "arguments": "{\\"summary\\": \\"ok\\"}"}\n```';
    expect(toolCallsFromText(text, known)).toEqual([{ name: "finish", args: { summary: "ok" } }]);
  });

  it("ignores prose, unknown tools and broken JSON", () => {
    expect(toolCallsFromText("No issues here {really}.", known)).toEqual([]);
    expect(toolCallsFromText('{"name": "rm_rf", "arguments": {}}', known)).toEqual([]);
    expect(toolCallsFromText('{"name": "finish", "arguments": {', known)).toEqual([]);
  });
});
