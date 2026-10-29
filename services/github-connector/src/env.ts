import { z } from "zod";
import { BaseEnv, DbEnv, loadEnv, bool } from "@deepscan/platform";

const opt = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));

export const env = loadEnv(
  BaseEnv.extend(DbEnv.shape).extend({
    PUBLIC_URL: z.string().url().default("http://localhost:8080"),
    GITHUB_API_URL: z.string().url().default("https://api.github.com"),
    GITHUB_RAW_URL: z.string().url().default("https://raw.githubusercontent.com"),
    GITHUB_APP_ID: opt,
    GITHUB_APP_SLUG: opt,
    /** PEM, or base64-encoded PEM */
    GITHUB_PRIVATE_KEY: opt,
    GITHUB_WEBHOOK_SECRET: opt,
    GITHUB_CLIENT_ID: opt,
    GITHUB_CLIENT_SECRET: opt,
    /** optional read-only token used for public repos that do not have the App installed */
    GITHUB_TOKEN: opt,
    ALLOW_PUBLIC_SCANS: bool.default(true),
    SCAN_API_KEY: opt,
    FIXTURES_DIR: opt,
    DEMO_SITE_URL: opt,
    FINDINGS_API_URL: z.string().url().default("http://findings-api:8080"),
    VERIFIER_URL: z.string().url().default("http://verifier:8080"),
    MAX_FILES_PER_SCAN: z.coerce.number().int().default(1500),
    MAX_FILE_BYTES: z.coerce.number().int().default(300_000),
    BOT_NAME: z.string().default("ariada-deepscan"),
  }),
);

export const appConfigured = !!(env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY);
export const oauthConfigured = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
export const privateKeyPem = env.GITHUB_PRIVATE_KEY
  ? env.GITHUB_PRIVATE_KEY.includes("BEGIN") ? env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n") : Buffer.from(env.GITHUB_PRIVATE_KEY, "base64").toString("utf8")
  : undefined;
