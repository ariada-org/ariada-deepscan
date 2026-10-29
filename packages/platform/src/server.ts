import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { renderMetrics, counter } from "./metrics.js";

const httpRequests = counter("http_requests_total", "HTTP requests served");

export interface ServiceOptions {
  name: string;
  version?: string;
  podName: string;
  logLevel?: string;
  bodyLimit?: number;
  /** extra readiness check, e.g. DB ping */
  ready?: () => Promise<void>;
}

export type App = ReturnType<typeof withZod>;
function withZod(app: FastifyInstance) {
  return app.withTypeProvider<ZodTypeProvider>();
}

/**
 * Common bootstrap for every microservice: Zod validation/serialisation,
 * OpenAPI at /openapi.json, /healthz, /readyz, /metrics and an
 * `x-served-by` header that shows which replica answered (used in the demo
 * to make horizontal scaling visible).
 */
export async function createService(o: ServiceOptions): Promise<App> {
  const app = Fastify({
    logger: { level: o.logLevel ?? "info", base: { service: o.name, pod: o.podName } },
    bodyLimit: o.bodyLimit ?? 4 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: { info: { title: `deepscan ${o.name}`, version: o.version ?? "1.0.0" } },
    transform: jsonSchemaTransform,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-served-by", o.podName);
    if (!req.url.startsWith("/healthz") && !req.url.startsWith("/metrics")) {
      httpRequests.inc({ route: req.routeOptions.url ?? "unknown", status: String(reply.statusCode) });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: "invalid request", detail: err.validation });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
  });

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true, pod: o.podName }));
  app.get("/readyz", { schema: { hide: true } }, async (_req, reply) => {
    try {
      await o.ready?.();
      return { ok: true };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });
  app.get("/metrics", { schema: { hide: true } }, async (_req, reply) => {
    reply.type("text/plain; version=0.0.4");
    return renderMetrics(o.podName);
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return withZod(app);
}

export async function listen(app: App, port: number) {
  const close = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void close("SIGTERM"));
  process.once("SIGINT", () => void close("SIGINT"));
  await app.listen({ host: "0.0.0.0", port });
}
