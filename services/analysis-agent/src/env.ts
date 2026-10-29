import { z } from "zod";
import { BaseEnv, DbEnv, loadEnv } from "@deepscan/platform";

export const env = loadEnv(
  BaseEnv.extend(DbEnv.shape).extend({
    CONNECTOR_URL: z.string().url().default("http://github-connector:8080"),
    RAG_URL: z.string().url().default("http://rag-service:8080"),
    VERIFIER_URL: z.string().url().default("http://verifier:8080"),
    LLM_PROVIDER: z.enum(["anthropic", "openai", "mock"]).default("mock"),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
    ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com"),
    OPENAI_BASE_URL: z.string().url().default("http://ollama:11434/v1"),
    OPENAI_API_KEY: z.string().default("ollama"),
    OPENAI_MODEL: z.string().default("qwen2.5-coder:7b"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(0).max(32).default(2),
    JOB_LEASE_SECONDS: z.coerce.number().int().default(300),
    MAX_TURNS: z.coerce.number().int().min(1).max(20).default(8),
    MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(100).default(24),
    MAX_PROMPT_LINES: z.coerce.number().int().default(1200),
    MOCK_DELAY_MS: z.coerce.number().int().min(0).default(900),
    MOCK_HALLUCINATE_RATE: z.coerce.number().min(0).max(1).default(0.35),
    PROMPT_VERSION: z.string().default("v3"),
  }),
);
