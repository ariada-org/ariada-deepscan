/** Tiny Prometheus text-format registry (no external dependency). */
type Labels = Record<string, string>;

class Metric {
  readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string, readonly type: "counter" | "gauge") {}
  private key(l: Labels) {
    return Object.entries(l).sort().map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",");
  }
  inc(labels: Labels = {}, by = 1) {
    const k = this.key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  set(labels: Labels, v: number) {
    this.values.set(this.key(labels), v);
  }
}

const registry: Metric[] = [];
export function counter(name: string, help: string) {
  const m = new Metric(name, help, "counter");
  registry.push(m);
  return m;
}
export function gauge(name: string, help: string) {
  const m = new Metric(name, help, "gauge");
  registry.push(m);
  return m;
}
export function renderMetrics(pod: string): string {
  const out: string[] = [];
  for (const m of registry) {
    out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`);
    if (m.values.size === 0) out.push(`${m.name}{pod="${pod}"} 0`);
    for (const [k, v] of m.values) out.push(`${m.name}{pod="${pod}"${k ? "," + k : ""}} ${v}`);
  }
  return out.join("\n") + "\n";
}
