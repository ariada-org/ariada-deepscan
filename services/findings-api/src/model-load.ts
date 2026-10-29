/**
 * How busy the hardware behind the model is, for the scan page. Ollama's /api/ps says which model is
 * loaded and whether it sits in GPU memory; the load itself comes from wherever the model runs:
 *   host     scripts/host-load.mjs next to the host's Ollama (the cluster cannot see the host's GPU)
 *   cluster  the metrics API (metrics-server) for the ollama pod
 *   mock     nothing to measure
 */
import fs from "node:fs";
import https from "node:https";
import { z } from "zod";
import type { ProgressResponse } from "@deepscan/contracts";

export type ModelLoad = NonNullable<z.output<typeof ProgressResponse>["model"]>;
export type RunsOn = ModelLoad["runsOn"];

const Ps = z.object({ models: z.array(z.object({ name: z.string(), size: z.number(), size_vram: z.number().optional() })) });
const HostLoad = z.object({ gpuPct: z.number().nullable(), cpuPct: z.number().nullable() });
const PodMetrics = z.object({ items: z.array(z.object({ containers: z.array(z.object({ name: z.string(), usage: z.object({ cpu: z.string() }) })) })) });

/** a Kubernetes CPU quantity ("1234567n", "250m", "2") in cores */
export function cpuCores(q: string): number {
  const m = /^(\d+(?:\.\d+)?)([num]?)$/.exec(q);
  if (!m) return NaN;
  const div = { n: 1e9, u: 1e6, m: 1e3, "": 1 }[m[2] as "n" | "u" | "m" | ""];
  return Number(m[1]) / div;
}

/** put the pieces together; anything that could not be read stays null */
export function combine(runsOn: RunsOn, ps: z.output<typeof Ps> | null, host: z.output<typeof HostLoad> | null, podCores: number | null): ModelLoad {
  if (runsOn === "mock") return { runsOn, name: null, device: null, pct: null, cores: null };
  const m = ps?.models[0];
  const device = m ? ((m.size_vram ?? 0) > 0 ? "gpu" : "cpu") : runsOn === "cluster" ? "cpu" : null;
  const pct = runsOn === "host" && host && device ? (device === "cpu" ? host.cpuPct : host.gpuPct) : null;
  const round = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
  return { runsOn, name: m?.name ?? null, device, pct: round(pct), cores: runsOn === "cluster" ? round(podCores) : null };
}

async function getJson<S extends z.ZodType>(url: string, schema: S): Promise<z.output<S> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok ? schema.parse(await r.json()) : null;
  } catch {
    return null;
  }
}

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

/** CPU cores used by the ollama pod, from the metrics API, with this pod's service-account token */
function ollamaPodCores(): Promise<number | null> {
  let token: string, ca: Buffer, ns: string;
  try {
    token = fs.readFileSync(`${SA}/token`, "utf8");
    ca = fs.readFileSync(`${SA}/ca.crt`);
    ns = fs.readFileSync(`${SA}/namespace`, "utf8").trim();
  } catch {
    return Promise.resolve(null);   // no token mounted: only the cluster overlay grants one
  }
  const path = `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent("app.kubernetes.io/name=ollama")}`;
  return new Promise((resolve) => {
    const req = https.get({ host: "kubernetes.default.svc", path, ca, headers: { authorization: `Bearer ${token}` }, timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let p;
        try {
          p = res.statusCode === 200 ? PodMetrics.safeParse(JSON.parse(body)) : null;
        } catch {
          p = null;
        }
        if (!p?.success || !p.data.items.length) return resolve(null);
        resolve(p.data.items.flatMap((i) => i.containers).reduce((a, c) => a + cpuCores(c.usage.cpu), 0));
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/** a probe that every progress poll may call: it asks at most once every two seconds */
export function modelLoadProbe(o: { runsOn: RunsOn; openAiBaseUrl: string; hostLoadUrl: string }) {
  const base = o.openAiBaseUrl.replace(/\/v1\/?$/, "");
  let last: { at: number; value: Promise<ModelLoad> } | null = null;
  const probe = async (): Promise<ModelLoad> => {
    if (o.runsOn === "mock") return combine("mock", null, null, null);
    const [ps, host, cores] = await Promise.all([
      getJson(`${base}/api/ps`, Ps),
      o.runsOn === "host" ? getJson(o.hostLoadUrl, HostLoad) : null,
      o.runsOn === "cluster" ? ollamaPodCores() : null,
    ]);
    return combine(o.runsOn, ps, host, cores);
  };
  return () => {
    if (!last || Date.now() - last.at > 2000) last = { at: Date.now(), value: probe() };
    return last.value;
  };
}
