/**
 * Webhook receiver: verify HMAC, de-duplicate by delivery id, persist and ACK
 * with 202 immediately (GitHub expects a response within 10 s). Processing
 * happens asynchronously in the event worker (async request-reply pattern).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { App, Db, ZodTypeProvider } from "@deepscan/platform";
import { counter } from "@deepscan/platform";
import { env } from "./env.js";

const received = counter("connector_webhooks_total", "Webhook deliveries received, by event and outcome");
const HANDLED = new Set(["installation", "installation_repositories", "pull_request", "push", "issue_comment", "ping"]);

export function signatureValid(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function registerWebhooks(app: App, db: Db) {
  app.register(async (plain) => {
    const scope = plain.withTypeProvider<ZodTypeProvider>();
    // keep the raw bytes: the HMAC must be computed over exactly what GitHub sent
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post(
      "/gh/webhooks",
      {
        schema: {
          headers: z.object({
            "x-github-event": z.string().max(64),
            "x-github-delivery": z.string().max(100),
            "x-hub-signature-256": z.string().max(200).optional(),
          }),
          response: { 202: z.object({ accepted: z.boolean(), duplicate: z.boolean() }), 401: z.object({ error: z.string() }), 503: z.object({ error: z.string() }) },
        },
      },
      async (req, reply) => {
        if (!env.GITHUB_WEBHOOK_SECRET) return reply.code(503).send({ error: "webhooks not configured" });
        const raw = req.body as Buffer;
        const event = req.headers["x-github-event"];
        if (!signatureValid(env.GITHUB_WEBHOOK_SECRET, raw, req.headers["x-hub-signature-256"])) {
          received.inc({ event, outcome: "bad_signature" });
          req.log.warn({ event }, "webhook signature mismatch");
          return reply.code(401).send({ error: "invalid signature" });
        }
        const status = HANDLED.has(event) ? "pending" : "ignored";
        const res = await db
          .insertInto("webhook_deliveries")
          .values({ id: req.headers["x-github-delivery"], event, payload: raw.toString("utf8"), status, locked_until: null, error: null })
          .onConflict((oc) => oc.column("id").doNothing())
          .executeTakeFirst();
        const duplicate = Number(res.numInsertedOrUpdatedRows ?? 0) === 0;
        received.inc({ event, outcome: duplicate ? "duplicate" : status });
        return reply.code(202).send({ accepted: !duplicate, duplicate });
      },
    );
  });
}
