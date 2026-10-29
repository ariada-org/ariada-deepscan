/**
 * Typed REST client: every response is validated against its contract, so a
 * misbehaving or outdated service fails loudly at the boundary instead of
 * propagating malformed data.
 */
import type { z } from "zod";

export class RestError extends Error {
  constructor(message: string, readonly status: number | null, readonly body?: unknown) {
    super(message);
  }
}

export interface CallOptions<S extends z.ZodType> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  body?: unknown;
  schema: S;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callJson<S extends z.ZodType>(o: CallOptions<S>): Promise<z.output<S>> {
  const retries = o.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(200 * 2 ** (attempt - 1) + Math.random() * 100);
    let res: Response;
    try {
      res = await fetch(o.url, {
        method: o.method ?? (o.body === undefined ? "GET" : "POST"),
        headers: { accept: "application/json", ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...o.headers },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      lastErr = new RestError(`network error calling ${o.url}: ${(e as Error).message}`, null);
      continue;
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON */
    }
    if (res.status >= 500 || res.status === 429) {
      lastErr = new RestError(`${o.url} -> HTTP ${res.status}`, res.status, json ?? text);
      continue;
    }
    if (!res.ok) throw new RestError(`${o.url} -> HTTP ${res.status}`, res.status, json ?? text);
    const parsed = o.schema.safeParse(json);
    if (!parsed.success) {
      throw new RestError(`${o.url} returned a response that violates its contract: ${parsed.error.message}`, res.status, json);
    }
    return parsed.data;
  }
  throw lastErr;
}
