// Minimal GitHub REST API simulator for end-to-end tests of the GitHub App flow
// (installation tokens, trees, blobs, PR files, check runs, reviews, comments).
// Usage: node scripts/fake-github.mjs <baseDir> <headDir> [port]
import http from "node:http";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [baseDir, headDir, port = "9999"] = process.argv.slice(2);
const REPO = "acme/nordic-outdoor-gear";
const snap = (dir) => {
  const files = new Map();
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else { const buf = readFileSync(p); files.set(relative(dir, p), { buf, sha: createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex") }); } } };
  walk(dir);
  const sha = createHash("sha1").update([...files].map(([p, f]) => p + f.sha).join()).digest("hex");
  return { sha, files };
};
const base = snap(baseDir), head = snap(headDir);
const bySha = new Map([[base.sha, base], [head.sha, head]]);
const blobs = new Map([...base.files.values(), ...head.files.values()].map((f) => [f.sha, f.buf]));
const log = [];
let nextId = 100;

function patch(oldBuf, newBuf) {
  const n = newBuf.toString().split("\n");
  const o = oldBuf ? oldBuf.toString().split("\n") : [];
  return `@@ -1,${o.length} +1,${n.length} @@\n` + n.map((l) => "+" + l).join("\n");
}
const changed = [...head.files].filter(([p, f]) => base.files.get(p)?.sha !== f.sha).map(([p, f]) => ({ filename: p, status: base.files.has(p) ? "modified" : "added", patch: patch(base.files.get(p)?.buf, f.buf) }));

http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  log.push({ method: req.method, path: p, auth: req.headers.authorization?.slice(0, 12), body: body ? JSON.parse(body) : undefined });
  let m;
  if (p === "/_log") return send(200, log);
  if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p))) return req.headers.authorization?.startsWith("Bearer ey") ? send(201, { token: "ghs_fake_" + m[1], expires_at: new Date(Date.now() + 3600e3).toISOString() }) : send(401, { message: "bad jwt" });
  if (p === `/repos/${REPO}`) return send(200, { id: 4242, full_name: REPO, private: true, default_branch: "main", homepage: "https://nordic-gear.example" });
  if ((m = new RegExp(`^/repos/${REPO}/commits/(.+)$`).exec(p))) return send(200, { sha: m[1] === "feature" ? head.sha : base.sha });
  if ((m = new RegExp(`^/repos/${REPO}/git/trees/([a-f0-9]{40})$`).exec(p))) { const s = bySha.get(m[1]); return s ? send(200, { sha: s.sha, truncated: false, tree: [...s.files].map(([path, f]) => ({ path, type: "blob", sha: f.sha, size: f.buf.length })) }) : send(404, {}); }
  if ((m = new RegExp(`^/repos/${REPO}/git/blobs/([a-f0-9]{40})$`).exec(p))) { const b = blobs.get(m[1]); return b ? send(200, { content: b.toString("base64"), encoding: "base64", size: b.length }) : send(404, {}); }
  if (new RegExp(`^/repos/${REPO}/pulls/7/files$`).test(p)) return send(200, url.searchParams.get("page") === "1" || !url.searchParams.get("page") ? changed : []);
  if (new RegExp(`^/repos/${REPO}/pulls/7$`).test(p)) return send(200, { number: 7, head: { sha: head.sha, ref: "feature" }, base: { sha: base.sha, ref: "main" } });
  if (p === `/repos/${REPO}/check-runs` && req.method === "POST") return send(201, { id: nextId++ });
  if (/\/check-runs\/\d+$/.test(p)) return send(200, { ok: true });
  if (/\/pulls\/7\/reviews$/.test(p)) return send(200, { id: nextId++ });
  if (/\/issues\/7\/comments$/.test(p)) return req.method === "GET" ? send(200, []) : send(201, { id: nextId++ });
  send(404, { message: "not simulated", path: p });
}).listen(Number(port), () => console.log(JSON.stringify({ port, base: base.sha, head: head.sha, changed: changed.map((c) => c.filename) })));
