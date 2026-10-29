/**
 * Dashboard service: serves the SPA with strict security headers. When reached
 * directly (local/docker-compose) it also forwards /api/* and /gh/* to the
 * findings-api and github-connector; in Kubernetes the Ingress routes those
 * paths straight to the services.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BaseEnv, loadEnv, createService, listen, bool, type FastifyRequest, type FastifyReply } from "@deepscan/platform";

const env = loadEnv(BaseEnv.extend({
  FINDINGS_API_URL: z.string().url().default("http://findings-api:8080"),
  CONNECTOR_URL: z.string().url().default("http://github-connector:8080"),
  PROXY_UPSTREAMS: bool.default(true),
  WEB_DIR: z.string().optional(),
}));

const here = dirname(fileURLToPath(import.meta.url));
async function loadAssets(): Promise<Record<string, { type: string; body: Buffer }>> {
  const dir = env.WEB_DIR ?? [join(here, "public"), join(here, "../dist/public")].find((d) => existsSync(join(d, "app.js")));
  if (!dir) {
    // dev mode (tsx): bundle on the fly
    const esbuild = await import("esbuild");
    const r = await esbuild.build({ entryPoints: [join(here, "../web/app.ts")], bundle: true, format: "esm", target: "es2022", write: false, minify: true });
    return {
      "/app.js": { type: "text/javascript; charset=utf-8", body: Buffer.from(r.outputFiles[0]!.contents) },
      "/styles.css": { type: "text/css; charset=utf-8", body: await readFile(join(here, "../web/styles.css")) },
      "/": { type: "text/html; charset=utf-8", body: await readFile(join(here, "../web/index.html")) },
    };
  }
  return {
    "/app.js": { type: "text/javascript; charset=utf-8", body: await readFile(join(dir, "app.js")) },
    "/styles.css": { type: "text/css; charset=utf-8", body: await readFile(join(dir, "styles.css")) },
    "/": { type: "text/html; charset=utf-8", body: await readFile(join(dir, "index.html")) },
  };
}
const assets = await loadAssets();

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://avatars.githubusercontent.com", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join("; ");

const app = await createService({ name: "dashboard", podName: env.POD_NAME, logLevel: env.LOG_LEVEL });
app.addHook("onSend", async (_req, reply) => {
  reply.header("content-security-policy", CSP).header("x-content-type-options", "nosniff").header("referrer-policy", "same-origin").header("x-frame-options", "DENY");
});

for (const [path, a] of Object.entries(assets)) {
  app.get(path === "/" ? "/" : path, { schema: { hide: true } }, async (_req, reply) => {
    reply.type(a.type).header("cache-control", path === "/" ? "no-cache" : "public, max-age=300");
    return a.body;
  });
}
app.get("/index.html", { schema: { hide: true } }, async (_req, reply) => reply.redirect("/"));

if (env.PROXY_UPSTREAMS) {
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const forward = (base: string) => async (req: FastifyRequest, reply: FastifyReply) => {
      const headers: Record<string, string> = {};
      for (const k of ["cookie", "content-type", "accept", "x-api-key", "x-github-event", "x-github-delivery", "x-hub-signature-256", "user-agent"]) {
        const v = req.headers[k];
        if (typeof v === "string") headers[k] = v;
      }
      headers["x-forwarded-for"] = req.ip;
      const res = await fetch(base + req.url, {
        method: req.method, headers, redirect: "manual",
        body: ["GET", "HEAD"].includes(req.method) ? undefined : (req.body ? new Uint8Array(req.body as Buffer) : undefined),
        signal: AbortSignal.timeout(30_000),
      });
      reply.code(res.status);
      for (const k of ["content-type", "location", "cache-control"]) {
        const v = res.headers.get(k);
        if (v) reply.header(k, v);
      }
      const cookies = res.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return Buffer.from(await res.arrayBuffer());
    };
    scope.all("/api/*", { schema: { hide: true } }, forward(env.FINDINGS_API_URL));
    scope.all("/gh/*", { schema: { hide: true } }, forward(env.CONNECTOR_URL));
  });
}

await listen(app, env.PORT);
