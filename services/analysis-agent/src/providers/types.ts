import type { ToolDefinition } from "@deepscan/contracts";

export interface ToolCall { id: string; name: string; args: unknown }
export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string | null; toolCalls: ToolCall[] }
  | { role: "tool"; results: { id: string; content: string; isError: boolean }[] };

export interface CompletionRequest {
  system: string;
  messages: Msg[];
  tools: ToolDefinition[];
  /** only used by the mock provider to stay deterministic */
  file?: { path: string; content: string };
}
export interface Completion {
  text: string | null;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
}
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<Completion>;
}
