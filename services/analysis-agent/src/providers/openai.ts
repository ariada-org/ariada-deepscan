/** Any OpenAI-compatible chat-completions endpoint with tool calling (Ollama, vLLM, LM Studio, OpenAI). */
import { z } from "zod";
import { callJson } from "@deepscan/platform";
import type { LlmProvider, CompletionRequest, Completion, Msg } from "./types.js";

const Resp = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).nullable().optional(),
    }),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

function toOpenAi(m: Msg) {
  if (m.role === "user") return [{ role: "user", content: m.content }];
  if (m.role === "assistant")
    return [{ role: "assistant", content: m.text ?? "", tool_calls: m.toolCalls.length ? m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) : undefined }];
  return m.results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.content }));
}

/**
 * Some local models (qwen2.5-coder through Ollama, for one) write their tool calls into the message
 * text as JSON objects instead of the tool_calls field, so the server never parses them. Read them
 * back from the text: every top-level {"name": <known tool>, "arguments": {...}} object counts.
 */
export function toolCallsFromText(text: string, known: ReadonlySet<string>): { name: string; args: unknown }[] {
  const out: { name: string; args: unknown }[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = depth > 0;
    else if (c === "{") { if (depth++ === 0) start = i; }
    else if (c === "}" && depth > 0 && --depth === 0) {
      try {
        const o = JSON.parse(text.slice(start, i + 1)) as { name?: unknown; arguments?: unknown; parameters?: unknown };
        const raw = o.arguments ?? o.parameters ?? {};
        if (typeof o.name === "string" && known.has(o.name)) out.push({ name: o.name, args: typeof raw === "string" ? JSON.parse(raw) : raw });
      } catch { /* not a tool call */ }
    }
  }
  return out;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  constructor(readonly model: string, private key: string, private baseUrl: string, private timeoutMs = 240_000) {}
  async complete(req: CompletionRequest): Promise<Completion> {
    const r = await callJson({
      url: `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      schema: Resp,
      timeoutMs: this.timeoutMs,
      headers: { authorization: `Bearer ${this.key}` },
      body: {
        model: this.model, temperature: 0,
        messages: [{ role: "system", content: req.system }, ...req.messages.flatMap(toOpenAi)],
        tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      },
    });
    const msg = r.choices[0]!.message;
    const toolCalls = (msg.tool_calls ?? []).map((t) => {
      let args: unknown;
      try {
        args = JSON.parse(t.function.arguments || "{}");
      } catch {
        args = { __unparseable__: t.function.arguments };
      }
      return { id: t.id, name: t.function.name, args };
    });
    if (!toolCalls.length && msg.content) {
      const known = new Set(req.tools.map((t) => t.name));
      toolCallsFromText(msg.content, known).forEach((t, i) => toolCalls.push({ id: `text_${req.messages.length}_${i}`, ...t }));
    }
    return { text: msg.content ?? null, toolCalls, usage: r.usage ? { input: r.usage.prompt_tokens, output: r.usage.completion_tokens } : undefined };
  }
}
