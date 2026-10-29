import { createSign } from "node:crypto";
import type { z } from "zod";
import { callJson } from "@deepscan/platform";
import { env, privateKeyPem } from "../env.js";
import { GhInstallationToken } from "./schemas.js";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** GitHub App JWT (RS256, 9 min) — built with node:crypto, no extra dependency. */
export function appJwt(now = Math.floor(Date.now() / 1000)): string {
  if (!env.GITHUB_APP_ID || !privateKeyPem) throw new Error("GitHub App is not configured");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

export interface GhCall<S extends z.ZodType> {
  path: string;
  schema: S;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  token?: string | null;
  bearer?: string;
}

export function gh<S extends z.ZodType>(c: GhCall<S>): Promise<z.output<S>> {
  const auth = c.bearer ? `Bearer ${c.bearer}` : c.token ? `token ${c.token}` : undefined;
  return callJson({
    url: c.path.startsWith("http") ? c.path : `${env.GITHUB_API_URL}${c.path}`,
    method: c.method,
    body: c.body,
    schema: c.schema,
    timeoutMs: 20_000,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ariada-deepscan",
      ...(auth ? { authorization: auth } : {}),
    },
  });
}

const tokenCache = new Map<number, { token: string; exp: number }>();
/** Installation access token (1 h), cached until 5 minutes before expiry. */
export async function installationToken(installationId: number): Promise<string> {
  const hit = tokenCache.get(installationId);
  if (hit && hit.exp - Date.now() > 5 * 60_000) return hit.token;
  const r = await gh({ path: `/app/installations/${installationId}/access_tokens`, method: "POST", body: {}, schema: GhInstallationToken, bearer: appJwt() });
  tokenCache.set(installationId, { token: r.token, exp: Date.parse(r.expires_at) });
  return r.token;
}
