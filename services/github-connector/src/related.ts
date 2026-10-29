/** Resolve files referenced by a source file (imports, stylesheets, scripts) within the snapshot tree. */
import { posix } from "node:path";

const PATTERNS = [
  /\bimport\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
  /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /@import\s+(?:url\()?["']([^"']+)["']/g,
];
const EXTS = ["", ".tsx", ".ts", ".jsx", ".js", ".vue", ".svelte", ".css", ".scss", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

export function relatedPaths(path: string, content: string, exists: (p: string) => boolean): string[] {
  const dir = posix.dirname(path);
  const out = new Set<string>();
  for (const re of PATTERNS) {
    for (const m of content.matchAll(re)) {
      const spec = m[1]!;
      if (/^(https?:|data:|\/\/|#)/.test(spec)) continue;
      const base = spec.startsWith("/") ? spec.slice(1) : spec.startsWith(".") ? posix.join(dir, spec) : null;
      if (!base || base.startsWith("..")) continue;
      for (const ext of EXTS) {
        const cand = posix.normalize(base + ext);
        if (cand !== path && exists(cand)) {
          out.add(cand);
          break;
        }
      }
    }
  }
  return [...out].slice(0, 25);
}
