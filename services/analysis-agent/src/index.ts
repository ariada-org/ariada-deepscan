import { z } from "zod";
import { CandidateFinding, RepoPath, Verdict } from "@deepscan/contracts";
import { createService, listen, createDb } from "@deepscan/platform";
import { env } from "./env.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAiProvider } from "./providers/openai.js";
import { MockProvider } from "./providers/mock.js";
import type { LlmProvider } from "./providers/types.js";
import { analyse, verify, startWorkers } from "./worker.js";

function provider(): LlmProvider {
  if (env.LLM_PROVIDER === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    return new AnthropicProvider(env.ANTHROPIC_MODEL, env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL);
  }
  if (env.LLM_PROVIDER === "openai") return new OpenAiProvider(env.OPENAI_MODEL, env.OPENAI_API_KEY, env.OPENAI_BASE_URL);
  return new MockProvider(env.MOCK_DELAY_MS, env.MOCK_HALLUCINATE_RATE);
}

const llm = provider();
const { db, ping } = createDb(env.DATABASE_URL, Math.max(3, env.WORKER_CONCURRENCY + 2));
const app = await createService({ name: "analysis-agent", podName: env.POD_NAME, logLevel: env.LOG_LEVEL, ready: ping, bodyLimit: 4 * 1024 * 1024 });

/** Synchronous analysis of one file (no queue, no DB) — handy for testing and for the IDE/MCP use case. */
app.post(
  "/analyze",
  {
    schema: {
      body: z.object({ path: RepoPath, content: z.string().max(1_000_000) }),
      response: { 200: z.object({ provider: z.string(), results: z.array(z.object({ candidate: CandidateFinding, verdict: Verdict })) }) },
    },
  },
  async (req) => {
    const a = await analyse(llm, { scanId: null, ...req.body }, req.log);
    const l = await a.llm();
    return { provider: `${llm.name}:${llm.model}`, results: await verify(req.body.path, req.body.content, [...a.rules, ...l.candidates]) };
  },
);

app.log.info({ provider: llm.name, model: llm.model, concurrency: env.WORKER_CONCURRENCY }, "analysis-agent starting");
startWorkers(db, llm, app.log, env.WORKER_CONCURRENCY);
await listen(app, env.PORT);
