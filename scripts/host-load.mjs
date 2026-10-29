#!/usr/bin/env node
// How busy this machine's GPU and CPU are, for the scan page in host mode (LLM=host): the cluster
// cannot see the host's hardware, so scripts/deploy.sh starts this next to the host's Ollama.
//   GET http://127.0.0.1:11435/load  ->  {"gpuPct":76,"cpuPct":31}   (null: cannot tell)
// GPU: ioreg on macOS (Metal), nvidia-smi elsewhere. No dependencies beyond Node.
import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";

const PORT = Number(process.env.HOST_LOAD_PORT ?? 11435);
// Docker Desktop reaches the Mac's loopback; on Linux the kind network comes in on the gateway address
const BIND = process.env.HOST_LOAD_BIND ?? (process.platform === "darwin" ? "127.0.0.1" : "0.0.0.0");

const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 2000 }, (e, out) => ok(e ? "" : out)));

async function gpuPct() {
  if (process.platform === "darwin") {
    const m = /"Device Utilization %"=(\d+)/.exec(await run("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"]));
    return m ? Number(m[1]) : null;
  }
  const v = (await run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]))
    .split("\n").map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  return v.length ? Math.max(...v) : null;
}

// CPU share since the previous request (the first answer covers the time since start)
const busyIdle = () => os.cpus().reduce((a, c) => {
  const t = c.times;
  return { busy: a.busy + t.user + t.nice + t.sys + t.irq, idle: a.idle + t.idle };
}, { busy: 0, idle: 0 });
let prev = busyIdle();
function cpuPct() {
  const now = busyIdle();
  const busy = now.busy - prev.busy, total = busy + now.idle - prev.idle;
  prev = now;
  return total > 0 ? Math.round((100 * busy) / total) : null;
}

http.createServer(async (req, res) => {
  if (req.url !== "/load") return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ gpuPct: await gpuPct(), cpuPct: cpuPct() }));
}).listen(PORT, BIND, () => console.log(`host-load on http://${BIND}:${PORT}/load`));
