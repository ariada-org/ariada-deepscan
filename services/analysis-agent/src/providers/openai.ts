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

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  constructor(readonly model: string, private key: string, private baseUrl: string) {}
  async complete(req: CompletionRequest): Promise<Completion> {
    const r = await callJson({
      url: `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      schema: Resp,
      timeoutMs: 180_000,
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
    return { text: msg.content ?? null, toolCalls, usage: r.usage ? { input: r.usage.prompt_tokens, output: r.usage.completion_tokens } : undefined };
  }
}
