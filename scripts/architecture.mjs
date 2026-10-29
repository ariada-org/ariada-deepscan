#!/usr/bin/env node
// Draws the architecture diagram from one layout, three ways: as text (pasted into docs/REPORT.md
// between the architecture markers), as docs/assets/architecture.svg, and as a PNG rendered from
// that SVG with rsvg-convert. Edit the layout here, never the outputs.
//   node scripts/architecture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Layout on a character grid: x = column, y = row. Boxes are inclusive of their border.
const W = 109, H = 39;
const cluster = { x: 0, y: 7, w: 108, h: 31, title: "KUBERNETES NAMESPACE deepscan" };
const boxes = [
  { id: "browser", kind: "outside", x: 1, y: 1, w: 24, h: 4, lines: ["Browser / extension", "dashboard UI, overlay"] },
  { id: "github", kind: "outside", x: 34, y: 1, w: 30, h: 4, lines: ["GitHub", "App webhooks, REST API"] },
  { id: "llm", kind: "outside", x: 76, y: 1, w: 28, h: 4, lines: ["LLM endpoint (Ollama)", "qwen2.5-coder:7b"] },
  { id: "ingress", kind: "edge", x: 2, y: 9, w: 56, h: 6, lines: ["Ingress", "/      → dashboard", "/api   → findings-api", "/gh    → github-connector"] },
  { id: "dashboard", kind: "service", x: 2, y: 17, w: 14, h: 4, lines: ["dashboard", "SPA"] },
  { id: "findings", kind: "service", x: 18, y: 17, w: 18, h: 4, lines: ["findings-api", "read model"] },
  { id: "connector", kind: "service", x: 40, y: 17, w: 26, h: 4, lines: ["github-connector", "snapshots, jobs, checks"] },
  { id: "verifier", kind: "service", x: 28, y: 23, w: 17, h: 3, lines: ["verifier"] },
  { id: "rag", kind: "service", x: 28, y: 27, w: 17, h: 3, lines: ["rag-service"] },
  { id: "fixer", kind: "planned", x: 64, y: 9, w: 23, h: 6, lines: ["fix-agent (planned)", "verified findings", "→ patch → fix PR", "→ PR scan: resolved"] },
  { id: "agent", kind: "service", x: 76, y: 22, w: 28, h: 8, lines: ["analysis-agent × N", "LLM tool loop", "competing consumers", "scaled by its own HPA"] },
  { id: "db", kind: "data", x: 2, y: 33, w: 102, h: 4, lines: ["PostgreSQL 16 + pgvector — StatefulSet with a PersistentVolumeClaim", "repositories · scans · scan_jobs queue · findings · WCAG corpus (full-text + vectors)"] },
];
// Edges are orthogonal paths; the last point carries the arrowhead.
const edges = [
  { pts: [[5, 5], [5, 8]] },
  { pts: [[40, 5], [40, 8]], label: [[41, 6, "webhooks"]] },
  { pts: [[62, 16], [62, 5]], label: [[63, 15, "REST: trees, blobs,"], [63, 16, "checks, PR reviews"]] },
  { pts: [[68, 8], [68, 3], [64, 3]], dashed: true, label: [[69, 5, "opens fix PR"]] },
  { pts: [[88, 21], [88, 5]], label: [[89, 12, "chat + tool calls"]] },
  { pts: [[8, 15], [8, 16]], label: [[9, 15, "/"]] },
  { pts: [[26, 15], [26, 16]], label: [[27, 15, "/api"]] },
  { pts: [[50, 15], [50, 16]], label: [[51, 15, "/gh"]] },
  { pts: [[80, 21], [80, 18], [66, 18]], label: [[67, 19, "read_file,"], [67, 20, "list_related"]] },
  { pts: [[42, 21], [42, 22]], label: [[43, 21, "policy gate"]] },
  { pts: [[75, 24], [45, 24]], label: [[58, 23, "run_rules, verify"]] },
  { pts: [[75, 28], [45, 28]], label: [[57, 27, "search_wcag, get_sc"]] },
  { pts: [[26, 21], [26, 32]], label: [[27, 26, "reads"]] },
  { pts: [[36, 30], [36, 32]] },
  { pts: [[56, 21], [56, 32]], label: [[57, 26, "jobs"]] },
  { pts: [[90, 30], [90, 32]], label: [[91, 30, "claim jobs,"], [91, 31, "write findings"]] },
];

// ---------- text ----------
const grid = Array.from({ length: H }, () => Array(W).fill(" "));
const put = (x, y, c) => { if (y >= 0 && y < H && x >= 0 && x < W) grid[y][x] = c; };
const V = new Set(["│", "┼"]), Hz = new Set(["─", "┼"]);

function rect(b, [h, v, tl, tr, bl, br]) {
  const x2 = b.x + b.w - 1, y2 = b.y + b.h - 1;
  for (let x = b.x + 1; x < x2; x++) { put(x, b.y, h); put(x, y2, h); }
  for (let y = b.y + 1; y < y2; y++) { put(b.x, y, v); put(x2, y, v); }
  put(b.x, b.y, tl); put(x2, b.y, tr); put(b.x, y2, bl); put(x2, y2, br);
}
rect(cluster, ["═", "║", "╔", "╗", "╚", "╝"]);
[...` ${cluster.title} `].forEach((c, i) => put(cluster.x + 7 + i, cluster.y, c));
for (const b of boxes) {
  rect(b, b.kind === "planned" ? ["┄", "┆", "┌", "┐", "└", "┘"] : ["─", "│", "┌", "┐", "└", "┘"]);
  b.lines.forEach((t, i) => [...t].forEach((c, j) => put(b.x + 2 + j, b.y + 1 + i, c)));
}
const dir = ([x1, y1], [x2, y2]) => [Math.sign(x2 - x1), Math.sign(y2 - y1)];
for (const e of edges) {
  for (let s = 0; s < e.pts.length - 1; s++) {
    const [a, b] = [e.pts[s], e.pts[s + 1]], [dx, dy] = dir(a, b);
    for (let x = a[0], y = a[1]; ; x += dx, y += dy) {
      const cur = grid[y][x];
      const want = e.dashed ? (dx ? "┄" : "┆") : dx ? "─" : "│";
      put(x, y, cur === "═" ? "╪" : (dx ? V.has(cur) : Hz.has(cur)) ? "┼" : want);
      if (x === b[0] && y === b[1]) break;
    }
  }
  for (let s = 1; s < e.pts.length - 1; s++) {   // corners
    const [px, py] = e.pts[s], [ix, iy] = dir(e.pts[s], e.pts[s - 1]), [ox, oy] = dir(e.pts[s], e.pts[s + 1]);
    const up = iy < 0 || oy < 0, down = iy > 0 || oy > 0, left = ix < 0 || ox < 0, right = ix > 0 || ox > 0;
    put(px, py, down && left ? "┐" : down && right ? "┌" : up && left ? "┘" : up && right ? "└" : "┼");
  }
  const [tx, ty] = e.pts.at(-1), [dx, dy] = dir(e.pts.at(-2), e.pts.at(-1));
  put(tx, ty, dx > 0 ? "▶" : dx < 0 ? "◀" : dy > 0 ? "▼" : "▲");
  for (const [lx, ly, t] of e.label ?? []) [...t].forEach((c, i) => put(lx + i, ly, c));
}
[..."OUTSIDE THE CLUSTER"].forEach((c, i) => put(1 + i, 0, c));
const LEGEND = "┄┄ dashed = planned, not built yet: fix-agent closes the loop fix → PR → scan → resolved";
[...LEGEND].forEach((c, i) => put(1 + i, H - 1, c));
const text = grid.map((r) => r.join("").trimEnd()).join("\n");

// ---------- svg ----------
const CW = 9, CH = 22, PAD = 12;
const cx = (x) => PAD + x * CW + CW / 2, cy = (y) => PAD + y * CH + CH / 2;
const style = {
  outside: { fill: "#f8fafc", stroke: "#64748b" },
  edge: { fill: "#ffffff", stroke: "#1e293b" },
  service: { fill: "#eff6ff", stroke: "#2563eb" },
  data: { fill: "#ecfdf5", stroke: "#059669" },
  planned: { fill: "#fffbeb", stroke: "#b45309", dash: "6 4" },
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAD * 2 + W * CW} ${PAD * 2 + H * CH}" font-family="Atkinson Hyperlegible Next, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="13" role="img" aria-labelledby="t d">`);
svg.push(`<title id="t">Ariada DeepScan architecture</title>`);
svg.push(`<desc id="d">Browser and GitHub reach the cluster through one Ingress, which routes to the dashboard, findings-api and github-connector. github-connector writes scan jobs to PostgreSQL and calls the verifier as a policy gate. analysis-agent replicas claim jobs from PostgreSQL, call the LLM endpoint, read files through github-connector, search WCAG in rag-service and verify findings in the verifier, then write findings back. findings-api reads PostgreSQL for the UI. Dashed and not built yet: a fix-agent that turns verified findings into a fix pull request, whose own PR scan then reports them as resolved.</desc>`);
svg.push(`<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#334155"/></marker></defs>`);
svg.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
svg.push(`<text x="${cx(1) - CW / 2}" y="${cy(0) + 5}" font-weight="700" fill="#475569" letter-spacing=".08em" font-size="12">OUTSIDE THE CLUSTER</text>`);
const bx = (b) => ({ x: cx(b.x), y: cy(b.y), w: (b.w - 1) * CW, h: (b.h - 1) * CH });
{ const r = bx(cluster);
  svg.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="#fbfdff" stroke="#2563eb" stroke-width="1.5"/>`);
  svg.push(`<text x="${cx(cluster.x + 8)}" y="${r.y - 6}" font-weight="700" fill="#2563eb" letter-spacing=".08em" font-size="12">${cluster.title}</text>`); }
for (const b of boxes) {
  const r = bx(b), s = style[b.kind];
  svg.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.5"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`);
  b.lines.forEach((t, i) => {
    const y = cy(b.y + 1 + i) + 5;
    svg.push(b.id === "ingress" && i > 0
      ? `<text x="${r.x + 16}" y="${y}" xml:space="preserve" font-family="Atkinson Hyperlegible Mono, ui-monospace, Menlo, monospace" font-size="12.5" fill="#1e293b">${esc(t)}</text>`
      : `<text x="${r.x + r.w / 2}" y="${y}" text-anchor="middle" ${i === 0 ? 'font-weight="700" fill="#0f172a"' : 'fill="#334155"'}>${esc(t)}</text>`);
  });
}
for (const e of edges) {
  const pts = e.pts.map(([x, y]) => [cx(x), cy(y)]);
  const [dx, dy] = dir(e.pts.at(-2), e.pts.at(-1));
  pts[pts.length - 1] = [pts.at(-1)[0] + dx * CW, pts.at(-1)[1] + dy * CH];   // reach the box border
  const [sx, sy] = dir(e.pts[1], e.pts[0]);
  pts[0] = [pts[0][0] + sx * CW, pts[0][1] + sy * CH];
  svg.push(`<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${e.dashed ? "#b45309" : "#334155"}" stroke-width="1.4"${e.dashed ? ' stroke-dasharray="6 4"' : ""} marker-end="url(#a)"/>`);
  for (const [lx, ly, t] of e.label ?? [])
    svg.push(`<text x="${cx(lx) - CW / 2 + 2}" y="${cy(ly) + 5}" fill="#475569" font-size="12" stroke="#ffffff" stroke-width="4" paint-order="stroke">${esc(t)}</text>`);
}
svg.push(`<line x1="${cx(1)}" y1="${cy(H - 1)}" x2="${cx(4)}" y2="${cy(H - 1)}" stroke="#b45309" stroke-width="1.5" stroke-dasharray="6 4"/>`);
svg.push(`<text x="${cx(5)}" y="${cy(H - 1) + 5}" fill="#92400e" font-size="12.5">dashed = planned, not built yet: a fix-agent closes the loop fix → pull request → scan → resolved</text>`);
svg.push(`</svg>`);
const svgPath = join(root, "docs/assets/architecture.svg");
writeFileSync(svgPath, svg.join("\n") + "\n");
execFileSync("rsvg-convert", ["--zoom", "2", "-o", svgPath.replace(/\.svg$/, ".png"), svgPath]);

// ---------- report ----------
const report = join(root, "docs/REPORT.md");
const md = readFileSync(report, "utf8");
const block = `<!-- architecture:begin (generated by scripts/architecture.mjs) -->\n\`\`\`text\n${text}\n\`\`\`\n<!-- architecture:end -->`;
const next = md.replace(/<!-- architecture:begin[\s\S]*?<!-- architecture:end -->/, block);
if (next === md && !md.includes(block)) throw new Error("architecture markers not found in docs/REPORT.md");
writeFileSync(report, next);
console.log(text);
