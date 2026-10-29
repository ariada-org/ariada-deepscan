import { z } from "zod";
import { callJson } from "@deepscan/platform";
import type { LlmProvider, CompletionRequest, Completion, Msg } from "./types.js";

const Resp = z.object({
  content: z.array(z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
    z.object({ type: z.string() }).loose(),
  ])),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

function toAnthropic(m: Msg) {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant")
    return {
      role: "assistant",
      content: [
        ...(m.text ? [{ type: "text", text: m.text }] : []),
        ...m.toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.args ?? {} })),
      ],
    };
  return { role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, is_error: r.isError })) };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(readonly model: string, private key: string, private baseUrl: string) {}
  async complete(req: CompletionRequest): Promise<Completion> {
    const r = await callJson({
      url: `${this.baseUrl}/v1/messages`,
      schema: Resp,
      timeoutMs: 120_000,
      retries: 3,
      headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01" },
      body: {
        model: this.model, max_tokens: 4096, system: req.system,
        messages: req.messages.map(toAnthropic),
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      },
    });
    const text = r.content.filter((c): c is { type: "text"; text: string } => c.type === "text" && "text" in c).map((c) => c.text).join("\n") || null;
    const toolCalls = r.content
      .filter((c): c is { type: "tool_use"; id: string; name: string; input: unknown } => c.type === "tool_use")
      .map((c) => ({ id: c.id, name: c.name, args: c.input }));
    return { text, toolCalls, usage: r.usage ? { input: r.usage.input_tokens, output: r.usage.output_tokens } : undefined };
  }
}
