/**
 * Dependency-free embedding: signed feature hashing of stemmed unigrams and
 * bigrams into 256 dimensions (log-tf weighted, L2-normalised), plus a small
 * accessibility synonym expansion. It runs inside the container with no model
 * download and no external API, which keeps the RAG fully self-contained.
 * Swap `embed()` for a neural model (e.g. MiniLM) if recall needs to improve —
 * the pgvector column and the search code do not change.
 */
export const DIM = 256;

const STOP = new Set("a an the and or of to in on for with without is are be by as at it its this that from into not no can has have must should use using used".split(" "));
const SYN: Record<string, string[]> = {
  alt: ["alternative", "text"], alternative: ["alt"], label: ["name"], labelled: ["label"], unlabeled: ["label", "name"],
  name: ["label"], icon: ["image", "button"], img: ["image"], image: ["img"], contrast: ["color", "luminance"],
  colour: ["color"], focus: ["keyboard", "outline"], outline: ["focus"], keyboard: ["focus", "tabindex"],
  onclick: ["click", "keyboard"], click: ["keyboard", "pointer"], tabindex: ["focus", "order"], zoom: ["resize", "scale"],
  viewport: ["zoom", "scale"], lang: ["language"], language: ["lang"], heading: ["h1", "structure"], iframe: ["frame", "title"],
  placeholder: ["label"], autoplay: ["audio", "video", "pause"], link: ["anchor", "purpose"], aria: ["role", "name"],
};

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, (m) => (w.length > 4 ? "" : m));
}
export function tokens(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z][a-z0-9-]*|\d+(?:\.\d+)+/g) ?? [];
  const out: string[] = [];
  for (const r of raw) {
    if (STOP.has(r)) continue;
    out.push(stem(r));
    for (const s of SYN[r] ?? []) out.push(stem(s));
  }
  return out;
}
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function embed(text: string): number[] {
  const v = new Float64Array(DIM);
  const t = tokens(text);
  const feats = new Map<string, number>();
  for (let i = 0; i < t.length; i++) {
    feats.set(t[i]!, (feats.get(t[i]!) ?? 0) + 1);
    if (i + 1 < t.length) feats.set(`${t[i]}_${t[i + 1]}`, (feats.get(`${t[i]}_${t[i + 1]}`) ?? 0) + 0.5);
  }
  for (const [f, c] of feats) {
    const h = fnv1a(f);
    v[h % DIM]! += ((h >>> 31) & 1 ? 1 : -1) * (1 + Math.log(c));
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => Number((x / n).toFixed(6)));
}
export const toPgVector = (v: number[]) => `[${v.join(",")}]`;
