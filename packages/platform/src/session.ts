import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export const SESSION_COOKIE = "ds_session";
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export interface Session {
  login: string;
  avatarUrl: string | null;
  installationIds: number[];
}

/** Sessions live in Postgres keyed by sha256(cookie) — any replica of any service can validate them. */
export async function sessionFromCookie(db: Db, token: string | undefined): Promise<Session | null> {
  if (!token || token.length > 200) return null;
  const s = await db.selectFrom("sessions").selectAll().where("id", "=", hashToken(token)).where("expires_at", ">", new Date()).executeTakeFirst();
  return s ? { login: s.login, avatarUrl: s.avatar_url, installationIds: (s.installation_ids ?? []).map(Number) } : null;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
