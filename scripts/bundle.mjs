// Bundle each service into a single ESM file (dist/index.js …) with esbuild.
// Usage: node scripts/bundle.mjs [service ...]   (default: all services)
import { build } from "esbuild";
import { readFileSync, readdirSync, rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const all = readdirSync(join(root, "services")).filter((d) => existsSync(join(root, "services", d, "package.json")));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : all;

for (const svc of targets) {
  const dir = join(root, "services", svc);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const cfg = pkg.deepscan ?? {};
  const out = join(dir, "dist");
  rmSync(out, { recursive: true, force: true });
  await build({
    entryPoints: (cfg.entries ?? ["src/index.ts"]).map((e) => join(dir, e)),
    outdir: out,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: false,
    minify: false,
    external: ["pg-native", "esbuild"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  });
  if (cfg.web) {
    const pub = join(out, "public");
    mkdirSync(pub, { recursive: true });
    await build({ entryPoints: [join(dir, cfg.web, "app.ts")], outfile: join(pub, "app.js"), bundle: true, format: "esm", target: "es2022", minify: true, logLevel: "warning" });
    for (const f of ["index.html", "styles.css"]) copyFileSync(join(dir, cfg.web, f), join(pub, basename(f)));
  }
  console.log(`bundled ${svc} -> ${out}`);
}
