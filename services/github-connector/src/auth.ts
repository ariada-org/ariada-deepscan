/** "Sign in with GitHub" for the dashboard (GitHub App user-to-server OAuth). */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { App, Db } from "@deepscan/platform";
import { SESSION_COOKIE, hashToken, newToken } from "@deepscan/platform";
import { env, oauthConfigured } from "./env.js";
import { gh } from "./github/client.js";
import { GhOAuthToken, GhUser, GhUserInstallations } from "./github/schemas.js";

const secure = env.PUBLIC_URL.startsWith("https://");
const cookieOpts = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };

export function registerAuth(app: App, db: Db) {
  app.get("/gh/auth/login", { schema: { hide: true } }, async (_req, reply) => {
    if (!oauthConfigured) return reply.code(503).send({ error: "GitHub sign-in is not configured" });
    const state = randomBytes(16).toString("hex");
    reply.setCookie("ds_oauth_state", state, { ...cookieOpts, maxAge: 600 });
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    u.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/gh/auth/callback`);
    u.searchParams.set("state", state);
    return reply.redirect(u.toString());
  });

  app.get(
    "/gh/auth/callback",
    { schema: { hide: true, querystring: z.object({ code: z.string().max(100), state: z.string().max(100) }) } },
    async (req, reply) => {
      if (!oauthConfigured) return reply.code(503).send({ error: "GitHub sign-in is not configured" });
      if (!req.cookies.ds_oauth_state || req.cookies.ds_oauth_state !== req.query.state) return reply.code(400).send({ error: "invalid OAuth state" });
      reply.clearCookie("ds_oauth_state", cookieOpts);
      const tok = await gh({
        path: "https://github.com/login/oauth/access_token", method: "POST", schema: GhOAuthToken,
        body: { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: req.query.code, redirect_uri: `${env.PUBLIC_URL}/gh/auth/callback` },
      });
      if (!("access_token" in tok)) return reply.code(401).send({ error: `GitHub OAuth failed: ${tok.error}` });
      const user = await gh({ path: "/user", schema: GhUser, bearer: tok.access_token });
      const inst = await gh({ path: "/user/installations?per_page=100", schema: GhUserInstallations, bearer: tok.access_token });
      // the user token is used once to learn identity + installations, then discarded
      const token = newToken();
      await db.insertInto("sessions").values({
        id: hashToken(token), login: user.login, avatar_url: user.avatar_url ?? null,
        installation_ids: inst.installations.map((i) => i.id), expires_at: new Date(Date.now() + 8 * 3600_000),
      }).execute();
      req.log.info({ login: user.login, installations: inst.installations.length }, "user signed in");
      reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, maxAge: 8 * 3600 });
      return reply.redirect("/");
    },
  );

  app.post("/gh/auth/logout", { schema: { hide: true } }, async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await db.deleteFrom("sessions").where("id", "=", hashToken(t)).execute();
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });
}
