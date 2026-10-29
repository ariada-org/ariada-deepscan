import { z } from "zod";

/** Parse process.env against a schema; exit with a readable message on failure. */
export function loadEnv<S extends z.ZodType>(schema: S, source: NodeJS.ProcessEnv = process.env): z.output<S> {
  const r = schema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Invalid configuration:\n${lines}`);
    process.exit(1);
  }
  return r.data;
}

export const BaseEnv = z.object({
  PORT: z.coerce.number().int().default(8080),
  POD_NAME: z.string().default(() => process.env.HOSTNAME ?? "local"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const DbEnv = z.object({
  DATABASE_URL: z.string().url().default("postgres://deepscan:deepscan@localhost:5432/deepscan"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
});

export const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true" || v === "1");
