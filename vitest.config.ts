import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts", "services/*/test/**/*.test.ts"], env: { GITHUB_WEBHOOK_SECRET: "x" } } });
