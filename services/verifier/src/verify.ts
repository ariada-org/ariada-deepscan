/**
 * Deterministic verification of candidate findings (anti-hallucination). An LLM finding is only "verified" if a deterministic
 * rule reproduces it; it is "rejected" if it is not grounded in the file or a
 * deterministic check contradicts it; otherwise it is "unverifiable" (needs a
 * human). The fingerprint is computed here — never by the model.
 */
import { createHash } from "node:crypto";
import { type CandidateFinding, type Verdict, type ElementKind, type Fingerprint, scApplies, scInfo } from "@deepscan/contracts";
import { type El, type CssRule, type Parsed, classify, staticAttr } from "./model.js";
import { RULES, RULES_BY_ID, buildCtx, type Rule, type RuleResult, type Ctx } from "./rules.js";

type Check = Verdict["checks"][number];

export function fingerprint(sc: string, ruleId: string | null, path: string, anchor: string): Fingerprint {
  return createHash("sha256").update(`${sc}|${ruleId ?? "llm"}|${path}|${anchor}`).digest("hex").slice(0, 16) as Fingerprint;
}

export function selectorHint(el: El | null): string | null {
  if (!el || el.opaque) return null;
  const safe = (v: string) => v.replace(/["\\\n]/g, "");
  const id = staticAttr(el, "id");
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `${el.tag}#${id}`;
  let s = el.tag;
  const key = el.tag === "img" ? "src" : el.tag === "a" ? "href" : ["input", "select", "textarea", "button", "iframe"].includes(el.tag) ? (el.tag === "iframe" ? "src" : "name") : null;
  const kv = key ? staticAttr(el, key) : undefined;
  if (kv && kv.length < 200) s += `[${key}="${safe(kv)}"]`;
  const cls = staticAttr(el, "class")?.trim().split(/\s+/)[0];
  if (cls && /^[A-Za-z_-][\w-]*$/.test(cls)) s += `.${cls}`;
  return s === el.tag ? null : s;
}

function locate(content: string, snippet: string, line: number, lineOf: (o: number) => number): { start: number; end: number } | null {
  const occ: { start: number; end: number }[] = [];
  const s = snippet.replace(/\r\n?/g, "\n");
  for (let i = content.indexOf(s); i !== -1 && occ.length < 50; i = content.indexOf(s, i + 1)) occ.push({ start: i, end: i + s.length });
  if (occ.length === 0) {
    // tolerate whitespace / indentation differences only
    const parts = s.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (parts.length === 0 || parts.join("").length < 3) return null;
    const re = new RegExp(parts.join("\\s+"), "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) && occ.length < 50) occ.push({ start: m.index, end: m.index + m[0].length });
  }
  if (occ.length === 0) return null;
  return occ.reduce((best, o) => (Math.abs(lineOf(o.start) - line) < Math.abs(lineOf(best.start) - line) ? o : best));
}

function innermost<T extends { start: number; end: number }>(items: T[], s: number, e: number): T | null {
  let best: T | null = null;
  for (const it of items) if (it.start <= s && e <= it.end && (!best || it.end - it.start < best.end - best.start)) best = it;
  return best;
}

function runRule(rule: Rule, el: El | null, css: CssRule | null, ctx: Ctx): RuleResult | null {
  if (rule.target === "element") return el && !el.opaque && rule.selects(el) ? rule.check(el, ctx) : null;
  return css ? rule.check(css, ctx) : null;
}

/** Claims in an LLM message that a deterministic rule can confirm or refute. */
const CLAIMS: { re: RegExp; rule: string }[] = [
  { re: /\b(missing|no|without|lacks?|lacking|empty|absent)\b[^.]{0,25}\balt\b/i, rule: "img-alt" },
  { re: /\b(missing|no|without|lacks?|lacking)\b[^.]{0,30}\b(label|labell?ed)\b/i, rule: "form-control-label" },
  { re: /\b(missing|no|without|lacks?|lacking|empty)\b[^.]{0,30}\b(accessible name|name|text)\b/i, rule: "button-name" },
  { re: /\b(missing|no|without|lacks?|lacking|empty)\b[^.]{0,30}\b(accessible name|name|text)\b/i, rule: "link-name" },
  { re: /\b(missing|no|without|lacks?)\b[^.]{0,20}\blang\b/i, rule: "html-lang" },
  { re: /\bcontrast\b/i, rule: "color-contrast" },
  { re: /\b(missing|no|without|lacks?|empty)\b[^.]{0,20}\btitle\b/i, rule: "iframe-title" },
];

export function verifyCandidate(parsed: Parsed, cand: CandidateFinding, ctx: Ctx = buildCtx(parsed)): Verdict {
  const checks: Check[] = [];
  const reject = (reason: string, extra: Partial<Verdict> = {}): Verdict => ({
    status: "rejected", method: "none", reason, checks, fingerprint: null, line: cand.line,
    elementPath: null, elementKinds: [], selectorHint: null, ...extra,
  });

  // 1. grounding: the snippet must exist in the file
  const loc = locate(parsed.content, cand.snippet, cand.line, parsed.lineOf);
  if (!loc) {
    checks.push({ name: "snippet-grounded", ok: false, detail: "snippet not found in file" });
    return reject("Snippet does not occur in the file (likely hallucinated).");
  }
  const line = parsed.lineOf(loc.start);
  checks.push({ name: "snippet-grounded", ok: true, detail: line === cand.line ? `found at line ${line}` : `found at line ${line} (claimed ${cand.line})` });

  // 2. map the snippet to an element / CSS rule
  const lead = parsed.content.slice(loc.start, loc.end).search(/\S/);
  const s = loc.start + Math.max(0, lead);
  const el = innermost(parsed.elements, s, loc.end);
  const css = innermost(parsed.css, s, loc.end);
  const kinds: ElementKind[] = el ? classify(el) : [];
  if (css) kinds.push("style");
  if (kinds.length === 0) kinds.push("text");
  checks.push({ name: "element-mapped", ok: !!(el || css), detail: el ? `<${el.tag}> ${el.path}` : css ? `css ${css.selector}` : "no element" });

  // 3. criterion applicability (closed enum already guaranteed the SC exists)
  const applies = scApplies(cand.sc, kinds);
  checks.push({ name: "sc-applicable", ok: applies, detail: `${cand.sc} ${scInfo(cand.sc).title} vs [${kinds.join(", ")}]` });
  const anchor = el?.path ?? css?.path ?? `line:${line}`;
  const base = { line, elementPath: el?.path ?? css?.path ?? null, elementKinds: kinds, selectorHint: selectorHint(el) };
  if (!applies) return reject(`WCAG ${cand.sc} (${scInfo(cand.sc).title}) does not apply to this element.`, base);
  if (!el && !css && scInfo(cand.sc).appliesTo !== "any") return reject("Snippet does not point at an element.", base);

  // 4. deterministic re-check
  if (cand.ruleId) {
    const rule = RULES_BY_ID.get(cand.ruleId);
    if (rule) {
      if (rule.sc !== cand.sc) {
        checks.push({ name: "rule-sc-match", ok: false, detail: `${rule.id} maps to ${rule.sc}` });
        return reject(`Rule ${rule.id} is about WCAG ${rule.sc}, not ${cand.sc}.`, base);
      }
      const r = runRule(rule, el, css, ctx);
      if (r) {
        checks.push({ name: `recheck:${rule.id}`, ok: r.violates, detail: r.detail });
        return r.violates
          ? { status: "verified", method: "recomputed", reason: `Reproduced by rule ${rule.id}: ${r.detail}.`, checks, fingerprint: fingerprint(cand.sc, rule.id, cand.path, anchor), ...base }
          : reject(`Deterministic re-check (${rule.id}) did not reproduce: ${r.detail}.`, base);
      }
      checks.push({ name: `recheck:${rule.id}`, ok: true, detail: "rule cannot decide statically" });
    } else {
      checks.push({ name: "rule-known", ok: false, detail: `unknown rule '${cand.ruleId}'` });
    }
  }

  // LLM finding (or undecidable rule): try every rule for this criterion
  for (const rule of RULES.filter((r) => r.sc === cand.sc)) {
    const r = runRule(rule, el, css, ctx);
    if (r?.violates) {
      checks.push({ name: `recheck:${rule.id}`, ok: true, detail: r.detail });
      return { status: "verified", method: "recomputed", reason: `Reproduced by rule ${rule.id}: ${r.detail}.`, checks, fingerprint: fingerprint(cand.sc, rule.id, cand.path, anchor), ...base };
    }
  }
  // claims that a rule can refute
  for (const c of CLAIMS) {
    if (!c.re.test(cand.message)) continue;
    const rule = RULES_BY_ID.get(c.rule)!;
    const r = runRule(rule, el, css, ctx);
    if (r && !r.violates) {
      checks.push({ name: `claim:${rule.id}`, ok: false, detail: r.detail });
      return reject(`The claim is contradicted by a deterministic check (${rule.id}): ${r.detail}.`, base);
    }
  }
  return {
    status: "unverifiable", method: "grounded",
    reason: "Snippet, element and criterion are real, but the issue is semantic and cannot be re-derived deterministically — needs human review.",
    checks, fingerprint: fingerprint(cand.sc, cand.ruleId, cand.path, anchor), ...base,
  };
}
