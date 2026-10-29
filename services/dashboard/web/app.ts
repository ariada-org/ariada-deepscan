/**
 * Dashboard SPA (no framework). Every API response is parsed with the same Zod
 * contracts the services use — the type-safe layer reaches the browser too.
 */
import { z } from "zod";
import {
  Me, ReposResponse, ScansResponse, TreeResponse, ProgressResponse, FindingsResponse, DiffResponse,
  CreateScanResponse, ScanSummary, scInfo, understandingUrl, type WcagSc,
} from "@deepscan/contracts";

type Tree = z.output<typeof TreeResponse>;
type Progress = z.output<typeof ProgressResponse>;
type Finding = z.output<typeof FindingsResponse>["findings"][number];
type FileNode = Tree["files"][number];
type Scan = z.output<typeof ScanSummary>;

const GhConfig = z.object({ appConfigured: z.boolean(), signInEnabled: z.boolean(), installUrl: z.string().nullable(), publicScans: z.boolean() });

class ApiError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}
async function api<S extends z.ZodType>(url: string, schema: S, init?: RequestInit): Promise<z.output<S>> {
  const res = await fetch(url, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`, res.status);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(`The server answered in an unexpected format (${url}).`);
  return parsed.data;
}

/* ---------- tiny DOM helper ---------- */
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const main = document.getElementById("main")!;
const live = document.getElementById("live")!;
const say = (msg: string) => { live.textContent = msg; };
const scTitle = (sc: string) => { try { return scInfo(sc as WcagSc).title; } catch { return ""; } };
const ago = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};
const statusPill = (s: string, label = s) => h("span", { class: `pill s-${s}` }, label);
const VERDICT_LABEL: Record<string, string> = { verified: "✓ Verified", unverifiable: "? Needs review", rejected: "✕ Rejected" };
const verdictPill = (v: string) => h("span", { class: `pill v-${v}` }, VERDICT_LABEL[v] ?? v);

/* A finished file is coloured by its most severe verified finding; with none verified it is either
   waiting for a human (unverifiable findings only) or clean. Every colour also has a glyph. */
type Outcome = "critical" | "serious" | "moderate" | "minor" | "review" | "clean";
const OUTCOMES: { key: Outcome; glyph: string; label: string }[] = [
  { key: "critical", glyph: "‼", label: "Critical" },
  { key: "serious", glyph: "!", label: "Serious" },
  { key: "moderate", glyph: "◆", label: "Moderate" },
  { key: "minor", glyph: "•", label: "Minor" },
  { key: "review", glyph: "?", label: "Needs human review" },
  { key: "clean", glyph: "✓", label: "No issues" },
];
const OUTCOME = new Map(OUTCOMES.map((o) => [o.key, o]));
const outcomeOf = (f: FileNode): Outcome | null =>
  f.status !== "done" ? null : f.worstSeverity ?? (f.unverifiable ? "review" : "clean");
const outcomeChip = (o: Outcome, text = OUTCOME.get(o)!.label) =>
  h("span", { class: "chip", "data-outcome": o }, h("span", { "aria-hidden": "true" }, OUTCOME.get(o)!.glyph), ` ${text}`);

let stopPolling: (() => void) | null = null;
function setPage(title: string, ...nodes: Node[]) {
  document.title = `${title} – Ariada DeepScan`;
  main.replaceChildren(...nodes);
  main.focus({ preventScroll: true });
}

/* ---------- account bar ---------- */
let config: z.output<typeof GhConfig> = { appConfigured: false, signInEnabled: false, installUrl: null, publicScans: true };
let me: z.output<typeof Me> | null = null;
async function renderAccount() {
  const nav = document.getElementById("account")!;
  [config, me] = await Promise.all([api("/gh/config", GhConfig).catch(() => config), api("/api/me", Me).catch(() => null)]);
  const items: Child[] = [];
  if (config.installUrl) items.push(h("a", { href: config.installUrl }, "Install the GitHub App"));
  if (me?.authenticated) {
    if (me.avatarUrl) items.push(h("img", { class: "avatar", src: me.avatarUrl, alt: "" }));
    items.push(h("span", {}, me.login ?? ""));
    items.push(h("button", { class: "btn-quiet", type: "button", onclick: async () => { await fetch("/gh/auth/logout", { method: "POST" }); location.reload(); } }, "Sign out"));
  } else if (config.signInEnabled) items.push(h("a", { class: "btn btn-quiet", href: "/gh/auth/login" }, "Sign in with GitHub"));
  nav.replaceChildren(...items.filter((x): x is Node => x instanceof Node));
}

/* ---------- home ---------- */
/** starts a scan and opens it; on failure the message goes into `err` and the button is re-enabled */
async function startScan(body: object, btn: HTMLButtonElement, err: HTMLElement) {
  err.textContent = "";
  btn.disabled = true;
  try {
    const r = await api("/gh/scans", CreateScanResponse, { method: "POST", body: JSON.stringify(body) });
    location.hash = `#/scans/${r.scanId}`;
  } catch (e) {
    err.textContent = (e as Error).message;
    btn.disabled = false;
  }
}

/** "Rescan" — a new full scan of the repository's default branch, e.g. after the issues were fixed */
function rescanButton(repoId: string) {
  const err = h("span", { class: "error", role: "alert" });
  const btn: HTMLButtonElement = h("button", { type: "button", onclick: () => void startScan({ repoId }, btn, err) }, "Rescan");
  return h("span", { class: "rescan" }, btn, err);
}

type Crumb = { label: string; href?: string; mono?: boolean };
const crumbs = (...items: Crumb[]) =>
  h("nav", { class: "crumbs", "aria-label": "Breadcrumb" },
    h("ol", {}, items.map((c, i) => h("li", {},
      i === items.length - 1
        ? h("span", { "aria-current": "page", class: c.mono ? "mono" : undefined }, c.label)
        : h("a", { href: c.href, class: c.mono ? "mono" : undefined }, c.label)))));

async function home() {
  const err = h("p", { class: "error", role: "alert" });
  const input = h("input", { id: "repo-url", name: "repo", type: "url", inputmode: "url", placeholder: "https://github.com/owner/repo", "aria-describedby": "repo-hint", required: true, autocomplete: "off" });
  const submit = h("button", { type: "submit" }, "Scan repository");
  const form = h("form", { class: "scan-form", onsubmit: (e: Event) => { e.preventDefault(); void startScan({ repoUrl: input.value.trim() }, submit, err); } },
    h("h2", {}, "Scan a repository"),
    h("label", { for: "repo-url" }, "GitHub repository URL"),
    input,
    h("p", { id: "repo-hint", class: "hint" }, config.publicScans ? "Public repositories can be scanned directly. Install the GitHub App to scan private repositories and to get checks on pull requests." : "Install the GitHub App, then pick one of your repositories below."),
    h("div", { class: "row" }, submit),
    err,
  );
  const reposBox = h("section", { "aria-labelledby": "repos-h" }, h("h2", { id: "repos-h", style: { marginBottom: ".75rem" } }, "Repositories"), h("p", { class: "empty" }, "Loading…"));
  setPage("Repositories",
    h("section", { class: "intro" },
      h("div", {},
        h("h1", {}, "Find accessibility problems across a whole repository."),
        h("p", { class: "lede" }, "Every file is read by an AI agent that looks up WCAG 2.2 guidance as it works. Each finding is then re-checked by deterministic rules, so you can see what is proven, what needs a human, and what the model got wrong."),
        h("ol", { class: "pipeline" },
          h("li", {}, h("span", {}, "The repository snapshot is split into one job per markup or style file.")),
          h("li", {}, h("span", {}, "Agent pods take jobs from the queue and call the WCAG knowledge base through tools.")),
          h("li", {}, h("span", {}, "The verifier proves, rejects or flags each finding for review.")),
          h("li", {}, h("span", {}, "On pull requests, only new issues can fail the GitHub check.")),
        ),
      ),
      form,
    ),
    reposBox,
  );
  try {
    const { repos } = await api("/api/repos", ReposResponse);
    const demo = repos.find((r) => r.source === "fixture");
    const rows = repos.map((r) =>
      h("tr", {},
        h("td", {}, h("a", { href: `#/repos/${r.id}` }, h("span", { class: "mono" }, r.fullName))),
        h("td", {}, r.source === "github-app" ? "GitHub App" : r.source === "fixture" ? "Built-in demo" : "Public"),
        h("td", {}, r.lastScan ? h("span", {}, statusPill(r.lastScan.status), " ", ago(r.lastScan.createdAt)) : "Never scanned"),
        h("td", {}, r.lastScan ? h("a", { href: `#/scans/${r.lastScan.id}` }, "Open last scan") : null),
      ));
    const demoBtn = demo ? h("button", { type: "button", class: "btn-quiet", onclick: (e: Event) => void startScan({ repoId: demo.id }, e.currentTarget as HTMLButtonElement, err) }, "Scan the demo repository") : null;
    reposBox.replaceChildren(
      h("div", { class: "toolbar" }, h("h2", { id: "repos-h" }, "Repositories"), demoBtn),
      repos.length
        ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Repository"), h("th", { scope: "col" }, "Source"), h("th", { scope: "col" }, "Last scan"), h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")))), h("tbody", {}, rows)))
        : h("p", { class: "empty" }, "No repositories yet. Paste a GitHub URL above to run the first scan."),
    );
  } catch (e) {
    reposBox.replaceChildren(h("p", { class: "error" }, (e as Error).message));
  }
}

/** what this scan changed: a pull request against its base, a full scan against the previous completed full scan */
function compareLink(s: Scan, scans: Scan[]) {
  if (s.kind === "pr") return s.baseScanId ? h("a", { href: `#/scans/${s.baseScanId}/diff/${s.id}` }, "Compare with base commit") : null;
  if (s.status !== "completed") return null;
  const prev = scans.filter((x) => x.kind === "full" && x.status === "completed" && x.id !== s.id && Date.parse(x.createdAt) < Date.parse(s.createdAt))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return prev ? h("a", { href: `#/scans/${prev.id}/diff/${s.id}` }, "What changed since the previous scan") : null;
}

/** replaces a compare link's text with the outcome, e.g. "3 fixed · 1 new" */
async function fillDiffCounts(a: HTMLAnchorElement) {
  const m = /#\/scans\/([0-9a-f-]{36})\/diff\/([0-9a-f-]{36})$/.exec(a.href);
  if (!m) return;
  try {
    const items = (await api(`/api/scans/${m[1]}/diff/${m[2]}`, DiffResponse)).items.filter((i) => i.status !== "rejected");
    const fixed = items.filter((i) => i.diff === "resolved").length, added = items.filter((i) => i.diff === "regression").length;
    a.textContent = fixed || added ? [fixed && `${fixed} fixed`, added && `${added} new`].filter(Boolean).join(" · ") : "No change";
    a.title = "Open the comparison with the previous scan";
  } catch { /* keep the generic label */ }
}

/* ---------- repo ---------- */
async function repoPage(id: string) {
  setPage("Repository", h("p", { class: "empty" }, "Loading…"));
  try {
    const { scans } = await api(`/api/repos/${id}/scans`, ScansResponse);
    const name = scans[0]?.repoFullName ?? "Repository";
    setPage(name,
      crumbs({ label: "Home", href: "#/" }, { label: name, mono: true }),
      h("div", { class: "page-head" }, h("h1", { class: "mono" }, name), rescanButton(id)),
      scans.length
        ? h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, ...["Scan", "Changes", "Ref", "Status", "Started"].map((t) => h("th", { scope: "col" }, t)))),
            h("tbody", {}, scans.map((s) => h("tr", {},
              h("td", {}, h("a", { href: `#/scans/${s.id}` }, s.kind === "pr" ? `Pull request #${s.prNumber}` : "Full scan")),
              h("td", {}, compareLink(s, scans) ?? "—"),
              h("td", { class: "mono" }, `${s.ref} @ ${s.headSha.slice(0, 7)}`),
              h("td", {}, statusPill(s.status)),
              h("td", {}, ago(s.createdAt)),
            )))))
        : h("p", { class: "empty" }, "No scans yet."),
    );
    for (const a of main.querySelectorAll<HTMLAnchorElement>("td a[href*='/diff/']")) void fillDiffCounts(a);
  } catch (e) {
    setPage("Not found", h("p", { class: "error" }, (e as Error).message));
  }
}

/* ---------- scan view ---------- */
const podIndex = new Map<string, number>();
const podVar = (pod: string | null) => {
  if (!pod) return undefined;
  if (!podIndex.has(pod)) podIndex.set(pod, podIndex.size % 6);
  return `var(--pod-${podIndex.get(pod)})`;
};
const shortPod = (p: string) => p.replace(/^analysis-agent-/, "");

/** how busy the hardware behind the model is, next to the elapsed time while a scan runs */
function modelLoad(m: NonNullable<Progress["model"]>) {
  if (m.runsOn === "mock") return h("span", { class: "load", title: "LLM=mock: a scripted stand-in answers, nothing is computed" }, "Mock model, no compute");
  const where = `${m.name ?? "model"} ${m.runsOn === "host" ? "on the host" : "in the ollama pod"}`;
  const unit = m.device === "gpu" ? "GPU" : "CPU";
  const amount = m.runsOn === "cluster"
    ? (m.cores === null ? "…" : `${m.cores.toFixed(1)} cores`)
    : (m.pct === null ? "…" : `${Math.round(m.pct)}%`);
  return h("span", { class: "load", title: m.name ? `busy share of the ${m.device === "gpu" ? "GPU" : "CPU"} that runs ${where}` : "the model is not loaded yet" },
    m.pct === null ? null : h("span", { class: "load-bar", "aria-hidden": "true" }, h("span", { style: { width: `${Math.min(100, Math.max(3, m.pct))}%` } })),
    h("span", { class: "mono" }, m.device ? `${unit} ${amount}` : "loading model"),
    ` · ${where}`);
}

interface ScanState { tree: Tree | null; progress: Progress | null; selected: string | null; showRejected: boolean; findings: Finding[]; findingsFor: string | null; }

function buildTree(files: FileNode[]) {
  type Dir = { dirs: Map<string, Dir>; files: FileNode[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(f);
  }
  return root;
}

async function scanPage(id: string) {
  const st: ScanState = { tree: null, progress: null, selected: null, showRejected: false, findings: [], findingsFor: null };
  const head = h("div", { class: "scan-head" });
  const ribbonBox = h("section", { class: "ribbon-wrap", "aria-labelledby": "ribbon-h" });
  const treeBox = h("section", { class: "panel", "aria-labelledby": "tree-h" });
  const findBox = h("section", { class: "panel", "aria-labelledby": "find-h" });
  const nav = h("div");
  setPage("Scan", nav, head, ribbonBox, h("div", { class: "split" }, treeBox, findBox));
  let history: Scan[] | null = null;
  let lastStatus = "";
  // Folders start open; one the user closes stays closed. Tracked per folder, because the tree is
  // still empty while the scan is ingesting and its folders only appear on a later poll.
  const openDirs = new Set<string>();
  const seenDirs = new Set<string>();

  const select = (path: string | null) => {
    st.selected = path;
    renderTree();
    renderRibbon();
    void loadFindings();
  };

  function renderHead() {
    const s = st.tree!.scan;
    const p = st.progress;
    const finished = s.status === "completed" || s.status === "failed";
    nav.replaceChildren(crumbs({ label: "Home", href: "#/" }, { label: s.repoFullName, href: `#/repos/${s.repoId}`, mono: true }, { label: s.kind === "pr" ? `Pull request #${s.prNumber}` : `Scan ${s.headSha.slice(0, 7)}` }));
    const cmp = history ? compareLink(s, history) : null;
    head.replaceChildren(
      h("div", {},
        h("div", { class: "page-head" }, h("h1", { class: "mono" }, s.repoFullName), finished ? rescanButton(s.repoId) : null),
        h("div", { class: "meta" },
          statusPill(s.status),
          h("span", {}, s.kind === "pr" ? `Pull request #${s.prNumber}` : "Full scan"),
          h("span", { class: "mono" }, `${s.ref} @ ${s.headSha.slice(0, 7)}`),
          p ? h("span", {}, `${(p.elapsedMs / 1000).toFixed(1)} s`) : null,
          p?.model && !finished ? modelLoad(p.model) : null,
          h("a", { href: `#/repos/${s.repoId}` }, "Scan history"),
          cmp,
        ),
      ),
    );
  }

  function renderRibbon() {
    const files = st.tree?.files ?? [];
    const p = st.progress;
    const done = p?.byStatus["done"] ?? 0;
    const perOutcome = new Map<Outcome, number>();
    const cells = files.map((f) => {
      const o = outcomeOf(f);
      if (o) perOutcome.set(o, (perOutcome.get(o) ?? 0) + 1);
      const state = o ? OUTCOME.get(o)!.label.toLowerCase() : f.status === "analyzing" ? "analysing" : f.status;
      return h("button", {
        type: "button", class: "cell", "data-status": f.status, "data-outcome": o, "aria-current": st.selected === f.path ? "true" : null,
        title: `${f.path} — ${state}${f.workerPod ? ` (${shortPod(f.workerPod)})` : ""}`,
        "aria-label": `${f.path}: ${state}${f.workerPod ? `, analysed by ${shortPod(f.workerPod)}` : ""}`,
        onclick: () => select(f.path),
      }, h("span", { "aria-hidden": "true" }, o ? OUTCOME.get(o)!.glyph : ""));
    });
    const failed = files.filter((f) => f.status === "error").length;
    const pods = (p?.pods ?? []).map((x) => h("span", {}, h("span", { class: "swatch", style: { background: podVar(x.pod), borderRadius: "50%" } }), h("span", { class: "mono" }, shortPod(x.pod)), ` ${x.files} file${x.files === 1 ? "" : "s"}`));
    ribbonBox.replaceChildren(
      h("h2", { id: "ribbon-h", class: "visually-hidden" }, "Scan progress"),
      h("div", { class: "ribbon", role: "group", "aria-label": `${done} of ${files.length} files analysed` }, cells),
      h("div", { class: "legend" },
        h("span", {}, h("span", { class: "swatch", "data-status": "queued" }), "Queued"),
        h("span", {}, h("span", { class: "swatch", "data-status": "analyzing" }), "Analysing now"),
        ...OUTCOMES.map((o) => h("span", {}, h("span", { class: "swatch", "data-outcome": o.key, "aria-hidden": "true" }, o.glyph), `${o.label}: ${perOutcome.get(o.key) ?? 0}`)),
        failed ? h("span", {}, h("span", { class: "swatch", "data-status": "error" }), `Analysis failed: ${failed}`) : null,
      ),
      ...(pods.length ? [h("div", { class: "legend legend-pods" }, h("span", {}, "Agent pods (dot in the file list):"), ...pods)] : []),
      h("div", { class: "counts" },
        h("div", {}, h("strong", {}, `${done}/${files.length}`), h("span", {}, "files analysed")),
        h("div", {}, h("strong", {}, String(p?.findings["verified"] ?? 0)), h("span", {}, "verified issues")),
        h("div", {}, h("strong", { class: "v-unverifiable" }, String(p?.findings["unverifiable"] ?? 0)), h("span", {}, "need human review")),
        h("div", {}, h("strong", { class: "v-rejected" }, String(p?.findings["rejected"] ?? 0)), h("span", {}, "AI claims rejected")),
      ),
    );
  }

  function renderTree() {
    const files = st.tree?.files ?? [];
    const root = buildTree(files);
    const walk = (d: ReturnType<typeof buildTree>, pre: string) => { for (const [n, c] of d.dirs) { const k = pre + n; if (!seenDirs.has(k)) { seenDirs.add(k); openDirs.add(k); } walk(c, k + "/"); } };
    walk(root, "");
    const analysing = files.filter((f) => f.status === "analyzing");
    const fileRow = (f: FileNode) =>
      h("li", {}, h("button", { type: "button", class: "file", "aria-current": st.selected === f.path ? "true" : null, onclick: () => select(f.path) },
        h("span", { class: "name" }, h("span", { class: "podchip", style: f.workerPod ? { background: podVar(f.workerPod) } : {}, "aria-hidden": "true" }), f.path.split("/").pop()!),
        f.status === "done"
          ? h("span", { class: "tally" },
              outcomeChip(outcomeOf(f)!, f.verified ? String(f.verified) : outcomeOf(f) === "review" ? "review" : "clean"),
              f.unverifiable && f.verified ? h("span", { class: "t v-unverifiable", title: "needs review" }, `?${f.unverifiable}`) : null,
              f.rejected ? h("span", { class: "t v-rejected", title: "AI claims rejected" }, `✕${f.rejected}`) : null,
              h("span", { class: "visually-hidden" }, `: worst ${f.worstSeverity ?? "none"}; ${f.verified} verified, ${f.unverifiable} need review, ${f.rejected} rejected`))
          : h("span", { class: `state s-${f.status}` }, f.status === "analyzing" ? "analysing…" : f.status)));
    const renderDir = (d: ReturnType<typeof buildTree>, pre: string): HTMLElement[] => [
      ...[...d.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => {
        const key = pre + name;
        const det = h("details", { open: openDirs.has(key) }, h("summary", {}, `${name}/`), h("ul", {}, renderDir(child, key + "/")));
        det.addEventListener("toggle", () => { if (det.open) openDirs.add(key); else openDirs.delete(key); });
        return h("li", {}, det);
      }),
      ...d.files.map(fileRow),
    ];
    treeBox.replaceChildren(
      h("div", { class: "toolbar" }, h("h2", { id: "tree-h" }, "Files"), st.selected ? h("button", { type: "button", class: "linkish", onclick: () => select(null) }, "Show all findings") : null),
      ...(analysing.length
        ? [h("div", { class: "now" }, h("span", {}, h("span", { class: "swatch", "data-status": "analyzing" }), "Analysing now"),
            ...analysing.map((f) => h("button", { type: "button", class: "nowitem mono", title: `${f.path}${f.workerPod ? ` — ${shortPod(f.workerPod)}` : ""}`, onclick: () => select(f.path) },
              h("span", { class: "podchip", style: f.workerPod ? { background: podVar(f.workerPod) } : {}, "aria-hidden": "true" }), f.path.split("/").pop()!)))]
        : []),
      files.length ? h("ul", { class: "tree" }, renderDir(root, "")) : h("p", { class: "empty" }, st.tree?.scan.status === "ingesting" ? "Reading the repository tree…" : "No markup or style files to analyse."),
    );
  }

  async function loadFindings() {
    const q = st.selected ? `?path=${encodeURIComponent(st.selected)}` : "";
    try {
      st.findings = (await api(`/api/scans/${id}/findings${q}`, FindingsResponse)).findings;
      st.findingsFor = st.selected;
    } catch { /* keep previous */ }
    renderFindings();
  }

  function renderFindings() {
    const order = { verified: 0, unverifiable: 1, rejected: 2 } as Record<string, number>;
    const sev = { critical: 0, serious: 1, moderate: 2, minor: 3 } as Record<string, number>;
    const list = st.findings.filter((f) => st.showRejected || f.status !== "rejected").sort((a, b) => order[a.status]! - order[b.status]! || sev[a.severity]! - sev[b.severity]! || a.path.localeCompare(b.path) || a.line - b.line);
    const hidden = st.findings.filter((f) => f.status === "rejected").length;
    const toggle = h("input", { type: "checkbox", id: "show-rej", checked: st.showRejected, onchange: (e: Event) => { st.showRejected = (e.target as HTMLInputElement).checked; renderFindings(); } });
    findBox.replaceChildren(
      h("div", { class: "toolbar" },
        h("h2", { id: "find-h" }, st.selected ? h("span", { class: "mono" }, st.selected) : "All findings"),
        h("label", { for: "show-rej" }, toggle, `Show rejected AI claims (${hidden})`)),
      list.length ? h("div", {}, list.map(findingView)) : h("p", { class: "empty" }, st.tree?.scan.status === "completed" ? "No issues found here." : "Findings appear as files finish."),
    );
  }

  const findingView = (f: Finding) =>
    h("article", { class: "finding", "data-v": f.status },
      h("div", { class: "top" },
        verdictPill(f.status),
        h("a", { class: "sc", href: understandingUrl(f.sc as WcagSc), target: "_blank", rel: "noopener" }, `WCAG ${f.sc} ${scTitle(f.sc)}`),
        outcomeChip(f.severity, f.severity),
        h("span", { class: "src" }, f.source === "llm" ? "AI agent" : `rule ${f.ruleId}`),
      ),
      h("div", { class: "where" }, `${f.path}:${f.line}`, f.workerPod ? ` (${shortPod(f.workerPod)})` : ""),
      h("pre", {}, h("code", {}, f.snippet)),
      h("p", { class: "msg" }, f.message),
      f.suggestion && f.status !== "rejected" ? h("p", { class: "fix" }, h("strong", {}, "Fix: "), f.suggestion) : null,
      h("p", { class: "why" }, h("strong", {}, "Verifier: "), f.reason),
      f.fingerprint ? h("p", { class: "why mono" }, `fingerprint ${f.fingerprint}`) : null,
    );

  async function tick() {
    try {
      const [tree, progress] = await Promise.all([api(`/api/scans/${id}/tree`, TreeResponse), api(`/api/scans/${id}/progress`, ProgressResponse)]);
      st.tree = tree;
      st.progress = progress;
      if (!history && (progress.status === "completed" || progress.status === "failed")) {
        history = await api(`/api/repos/${tree.scan.repoId}/scans`, ScansResponse).then((r) => r.scans, () => []);
      }
      renderHead();
      renderRibbon();
      renderTree();
      await loadFindings();
      if (progress.status !== lastStatus) {
        if (lastStatus) say(`Scan ${progress.status}. ${progress.findings["verified"] ?? 0} verified issues.`);
        lastStatus = progress.status;
      }
      return progress.status === "completed" || progress.status === "failed";
    } catch (e) {
      // A scan that does not exist ends the page; anything else (a database hiccup under load, a pod
      // restarting) is temporary, so the page says so and keeps polling instead of freezing.
      const gone = e instanceof ApiError && e.status === 404;
      if (gone || !st.tree) {
        head.replaceChildren(h("p", { class: "error", role: "alert" }, (e as Error).message));
        return gone;
      }
      renderHead();
      head.append(h("p", { class: "error", role: "status" }, `Lost contact with the server (${(e as Error).message}). Retrying…`));
      return false;
    }
  }
  let stopped = false;
  stopPolling = () => { stopped = true; };
  while (!stopped) {
    const done = await tick();
    if (done) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/* ---------- diff view ---------- */
async function diffPage(base: string, headId: string) {
  setPage("Compare", h("p", { class: "empty" }, "Loading…"));
  try {
    const [d, hs] = await Promise.all([api(`/api/scans/${base}/diff/${headId}`, DiffResponse), api(`/api/scans/${headId}`, ScanSummary)]);
    const groups = (["regression", "resolved", "persistent"] as const).map((k) => ({ k, items: d.items.filter((i) => i.diff === k && i.status !== "rejected") }));
    const label = { regression: "New in this version", resolved: "Fixed in this version", persistent: "Already present before" };
    setPage("Compare",
      crumbs({ label: "Home", href: "#/" }, { label: hs.repoFullName, href: `#/repos/${hs.repoId}`, mono: true }, { label: hs.kind === "pr" ? `Pull request #${hs.prNumber}` : `Scan ${hs.headSha.slice(0, 7)}`, href: `#/scans/${headId}` }, { label: "Changes" }),
      h("h1", { class: "mono", style: { margin: ".5rem 0" } }, hs.repoFullName),
      h("p", { class: "hint", style: { marginBottom: "1rem" } }, `${hs.kind === "pr" ? `Pull request #${hs.prNumber}` : hs.ref} ${hs.kind === "pr" ? "compared with the base commit" : "compared with the previous full scan"}. Findings are matched by fingerprint, so moved code is not reported as new.`),
      h("div", { class: "diffbar" }, groups.map((g) => h("span", { class: `pill diff-${g.k}` }, `${label[g.k]}: ${g.items.length}`))),
      ...groups.map((g) => h("section", { class: "panel", style: { marginBottom: "1rem" }, "aria-label": label[g.k] },
        h("h2", { class: `diff-${g.k}`, style: { marginBottom: ".5rem" } }, label[g.k]),
        g.items.length ? h("ul", {}, g.items.map((i) => h("li", {}, verdictPill(i.status), " ", h("strong", {}, `WCAG ${i.sc}`), " ", h("span", { class: "mono" }, `${i.path}:${i.line}`), " ", i.message))) : h("p", { class: "empty" }, "None."))),
    );
  } catch (e) {
    setPage("Compare", h("p", { class: "error" }, (e as Error).message));
  }
}

/* ---------- router ---------- */
async function route() {
  stopPolling?.();
  stopPolling = null;
  const hash = location.hash.replace(/^#/, "") || "/";
  let m: RegExpExecArray | null;
  if ((m = /^\/scans\/([0-9a-f-]{36})\/diff\/([0-9a-f-]{36})$/.exec(hash))) return diffPage(m[1]!, m[2]!);
  if ((m = /^\/scans\/([0-9a-f-]{36})$/.exec(hash))) return scanPage(m[1]!);
  if ((m = /^\/repos\/([0-9a-f-]{36})$/.exec(hash))) return repoPage(m[1]!);
  return home();
}
window.addEventListener("hashchange", () => void route());
await renderAccount();
void route();
