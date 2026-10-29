/**
 * Tier-1 deterministic rules. Each rule only reports a
 * violation when it is statically certain; anything that depends on runtime
 * values (dynamic attributes, spreads, opaque components) returns `null`
 * ("cannot decide") instead of guessing. The same rule functions are used by
 * the verifier to re-check findings proposed by the LLM.
 */
import type { CandidateFinding, Severity, WcagSc, RepoPath } from "@deepscan/contracts";
import { type El, type CssRule, type Parsed, staticAttr, has, hasNonEmpty, isNativelyFocusable, hasClickHandler } from "./model.js";
import { parseColor, contrastRatio, isLargeText } from "./color.js";

export interface RuleResult {
  violates: boolean;
  detail: string;
}
export interface Ctx {
  parsed: Parsed;
  labelFor: Set<string>;
  dynamicLabelFor: boolean;
}
interface Base {
  id: string;
  sc: WcagSc;
  severity: Severity;
  summary: string;
  suggestion: string | null;
}
export interface ElementRule extends Base {
  target: "element";
  selects(el: El): boolean;
  check(el: El, ctx: Ctx): RuleResult | null;
}
export interface StyleRule extends Base {
  target: "css";
  check(rule: CssRule, ctx: Ctx): RuleResult | null;
}
export type Rule = ElementRule | StyleRule;

const ok = (detail: string): RuleResult => ({ violates: false, detail });
const bad = (detail: string): RuleResult => ({ violates: true, detail });

type NameState = "present" | "absent" | "unknown";
/** Static approximation of the accessible-name computation. */
export function nameState(el: El): NameState {
  if (el.hasSpread) return "unknown";
  if (hasNonEmpty(el, "aria-label") || hasNonEmpty(el, "aria-labelledby") || hasNonEmpty(el, "title")) return "present";
  if (el.text.length > 0) return "present";
  if (el.hasDynamicContent) return "unknown";
  const stack = [...el.children];
  while (stack.length) {
    const d = stack.pop()!;
    if (d.hasSpread || d.opaque) return "unknown";
    if (d.tag === "img" || (d.tag === "input" && staticAttr(d, "type") === "image")) {
      const alt = d.attrs.get("alt");
      if (alt?.kind === "dynamic") return "unknown";
      if (alt?.kind === "static" && alt.value.trim()) return "present";
    }
    if (hasNonEmpty(d, "aria-label") || hasNonEmpty(d, "aria-labelledby")) return "present";
    stack.push(...d.children);
  }
  return "absent";
}

const hidden = (el: El) => staticAttr(el, "aria-hidden") === "true" || has(el, "hidden");
const presentational = (el: El) => ["presentation", "none"].includes(staticAttr(el, "role") ?? "");

const NON_INTERACTIVE = new Set(["div", "span", "li", "p", "td", "tr", "section", "article", "img", "label", "i", "b", "strong", "em", "ul", "header", "footer", "main", "aside", "figure", "h1", "h2", "h3", "h4", "h5", "h6"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "slider", "textbox", "combobox"]);

export const RULES: Rule[] = [
  {
    id: "img-alt", target: "element", sc: "1.1.1", severity: "critical",
    summary: "Image has no text alternative (alt attribute missing).",
    suggestion: 'Add alt="…" describing the image, or alt="" if it is purely decorative.',
    selects: (el) => el.tag === "img",
    check(el) {
      if (el.hasSpread) return null;
      if (has(el, "alt")) return ok("img has an alt attribute");
      if (hasNonEmpty(el, "aria-label") || hasNonEmpty(el, "aria-labelledby")) return ok("img is labelled via ARIA");
      if (presentational(el) || hidden(el)) return ok("img is presentational/hidden");
      return bad("img has no alt, aria-label or aria-labelledby");
    },
  },
  {
    id: "img-alt-suspicious", target: "element", sc: "1.1.1", severity: "moderate",
    summary: "Image alt text is a placeholder or file name, not a description.",
    suggestion: "Describe what the image conveys in context (or use alt=\"\" if decorative).",
    selects: (el) => el.tag === "img",
    check(el) {
      const alt = staticAttr(el, "alt");
      if (alt == null) return null;
      const a = alt.trim();
      if (!a) return ok("empty alt (decorative)");
      const src = staticAttr(el, "src") ?? "";
      const base = src.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") ?? "";
      if (/^(image|img|photo|picture|pic|graphic|logo|icon|untitled|spacer|banner|placeholder|alt|bild|foto)$/i.test(a)) return bad(`alt="${a}" is a generic placeholder`);
      if (/\.(png|jpe?g|gif|svg|webp|avif)$/i.test(a)) return bad(`alt="${a}" is a file name`);
      if (base && a.toLowerCase() === base.toLowerCase() && /[-_\d]/.test(base)) return bad(`alt repeats the file name "${base}"`);
      return ok("alt looks descriptive");
    },
  },
  {
    id: "form-control-label", target: "element", sc: "4.1.2", severity: "critical",
    summary: "Form control has no programmatic label.",
    suggestion: "Associate a <label for=…>, wrap the control in <label>, or add aria-label/aria-labelledby. A placeholder is not a label.",
    selects: (el) => ["input", "select", "textarea"].includes(el.tag) && !["hidden", "submit", "reset", "button", "image"].includes(staticAttr(el, "type") ?? "text"),
    check(el, ctx) {
      if (el.hasSpread || el.attrs.get("type")?.kind === "dynamic") return null;
      if (hasNonEmpty(el, "aria-label") || hasNonEmpty(el, "aria-labelledby") || hasNonEmpty(el, "title")) return ok("labelled via aria-label/aria-labelledby/title");
      for (let p = el.parent; p; p = p.parent) if (p.tag === "label") return ok("wrapped in <label>");
      const id = el.attrs.get("id");
      if (id?.kind === "dynamic") return null;
      if (id?.kind === "static" && ctx.labelFor.has(id.value)) return ok(`<label for="${id.value}"> exists`);
      if (ctx.dynamicLabelFor) return null;
      if (ctx.parsed.lang === "jsx" && id?.kind === "static") return null; // label may live in another component
      return bad(`<${el.tag}> has no associated label${has(el, "placeholder") ? " (placeholder is not a label)" : ""}`);
    },
  },
  {
    id: "button-name", target: "element", sc: "4.1.2", severity: "critical",
    summary: "Button has no accessible name.",
    suggestion: "Give the button visible text or an aria-label (icon-only buttons need aria-label).",
    selects: (el) => el.tag === "button" || (el.tag === "input" && staticAttr(el, "type") === "button") || (staticAttr(el, "role") === "button" && !el.opaque),
    check(el) {
      if (el.tag === "input") return hasNonEmpty(el, "value") || hasNonEmpty(el, "aria-label") || hasNonEmpty(el, "title") ? ok("input button has a value/label") : el.hasSpread ? null : bad("input type=button without value or aria-label");
      if (hidden(el)) return ok("hidden");
      const s = nameState(el);
      return s === "unknown" ? null : s === "present" ? ok("button has an accessible name") : bad("button contains no text, no labelled image and no aria-label");
    },
  },
  {
    id: "link-name", target: "element", sc: "2.4.4", severity: "serious",
    summary: "Link has no accessible name.",
    suggestion: "Put descriptive text inside the link, give its image an alt, or add aria-label.",
    selects: (el) => el.tag === "a" && has(el, "href"),
    check(el) {
      if (hidden(el)) return ok("hidden");
      const s = nameState(el);
      return s === "unknown" ? null : s === "present" ? ok("link has an accessible name") : bad("link has no text, no labelled image and no aria-label");
    },
  },
  {
    id: "link-text-generic", target: "element", sc: "2.4.4", severity: "moderate",
    summary: "Link text does not describe its purpose.",
    suggestion: 'Use text that makes sense out of context (e.g. "Read the pricing guide") or add aria-label.',
    selects: (el) => el.tag === "a" && has(el, "href"),
    check(el) {
      if (el.hasSpread || el.hasDynamicContent) return null;
      if (hasNonEmpty(el, "aria-label") || hasNonEmpty(el, "aria-labelledby") || hasNonEmpty(el, "aria-describedby")) return ok("has ARIA name/description");
      const t = el.text.toLowerCase().replace(/[.…!:]+$/, "").trim();
      return /^(click here|click|here|read more|more|learn more|link|this|go|details|mehr|läs mer|klicka här)$/.test(t) ? bad(`link text "${el.text}" is generic`) : ok("link text is specific");
    },
  },
  {
    id: "html-lang", target: "element", sc: "3.1.1", severity: "serious",
    summary: "Page has no language declared on <html>.",
    suggestion: 'Add lang to the root element, e.g. <html lang="en">.',
    selects: (el) => el.tag === "html",
    check: (el) => (el.hasSpread || el.attrs.get("lang")?.kind === "dynamic" ? null : hasNonEmpty(el, "lang") ? ok("lang present") : bad("<html> has no lang attribute")),
  },
  {
    id: "document-title", target: "element", sc: "2.4.2", severity: "serious",
    summary: "Document has no <title>.",
    suggestion: "Add a unique, descriptive <title> inside <head>.",
    selects: (el) => el.tag === "head",
    check(el) {
      const t = el.children.find((c) => c.tag === "title");
      if (!t) return el.children.some((c) => c.opaque) ? null : bad("<head> contains no <title>");
      return t.text || t.hasDynamicContent ? ok("title present") : bad("<title> is empty");
    },
  },
  {
    id: "click-non-interactive", target: "element", sc: "2.1.1", severity: "serious",
    summary: "Click handler on a non-interactive element without keyboard support.",
    suggestion: "Use a <button>, or add role, tabindex=\"0\" and a key handler (Enter/Space).",
    selects: (el) => NON_INTERACTIVE.has(el.tag) && hasClickHandler(el),
    check(el) {
      if (el.hasSpread) return null;
      const role = staticAttr(el, "role");
      if (el.attrs.get("role")?.kind === "dynamic") return null;
      const keyboard = has(el, "onkeydown") || has(el, "onkeyup") || has(el, "onkeypress");
      const focusable = has(el, "tabindex");
      if (role && INTERACTIVE_ROLES.has(role) && focusable && keyboard) return ok("has role, tabindex and key handler");
      const missing = [!role || !INTERACTIVE_ROLES.has(role) ? "role" : "", !focusable ? "tabindex" : "", !keyboard ? "keyboard handler" : ""].filter(Boolean);
      return bad(`<${el.tag}> has a click handler but no ${missing.join(", ")}`);
    },
  },
  {
    id: "positive-tabindex", target: "element", sc: "2.4.3", severity: "moderate",
    summary: "Positive tabindex overrides the natural focus order.",
    suggestion: 'Use tabindex="0" (or -1) and order the DOM instead.',
    selects: (el) => has(el, "tabindex"),
    check(el) {
      const v = staticAttr(el, "tabindex");
      if (v == null) return null;
      return parseInt(v, 10) > 0 ? bad(`tabindex="${v}"`) : ok(`tabindex="${v}"`);
    },
  },
  {
    id: "iframe-title", target: "element", sc: "4.1.2", severity: "serious",
    summary: "Frame has no accessible name.",
    suggestion: "Add a title attribute describing the frame content.",
    selects: (el) => el.tag === "iframe" || el.tag === "frame",
    check: (el) => (el.hasSpread ? null : hasNonEmpty(el, "title") || hasNonEmpty(el, "aria-label") || hasNonEmpty(el, "aria-labelledby") ? ok("frame is titled") : hidden(el) ? ok("hidden") : bad("iframe has no title")),
  },
  {
    id: "meta-viewport-zoom", target: "element", sc: "1.4.4", severity: "critical",
    summary: "Viewport meta tag disables or limits zoom.",
    suggestion: "Remove user-scalable=no and maximum-scale below 2.",
    selects: (el) => el.tag === "meta" && staticAttr(el, "name")?.toLowerCase() === "viewport",
    check(el) {
      const c = staticAttr(el, "content");
      if (c == null) return null;
      const s = c.toLowerCase().replace(/\s/g, "");
      if (/user-scalable=(no|0)/.test(s)) return bad("user-scalable=no");
      const m = /maximum-scale=([\d.]+)/.exec(s);
      if (m && parseFloat(m[1]!) < 2) return bad(`maximum-scale=${m[1]}`);
      return ok("zoom allowed");
    },
  },
  {
    id: "media-autoplay", target: "element", sc: "1.4.2", severity: "moderate",
    summary: "Media autoplays with sound.",
    suggestion: "Add muted (or remove autoplay) and provide controls.",
    selects: (el) => (el.tag === "video" || el.tag === "audio") && has(el, "autoplay"),
    check: (el) => (el.hasSpread || el.attrs.get("muted")?.kind === "dynamic" ? null : has(el, "muted") ? ok("muted") : bad("autoplay without muted")),
  },
  {
    id: "aria-hidden-focusable", target: "element", sc: "4.1.2", severity: "serious",
    summary: "Focusable element is hidden from assistive technology.",
    suggestion: 'Remove aria-hidden="true" or make the element unfocusable (tabindex="-1" / disabled).',
    selects: (el) => staticAttr(el, "aria-hidden") === "true",
    check(el) {
      const ti = staticAttr(el, "tabindex");
      if (ti != null && parseInt(ti, 10) < 0) return ok("tabindex=-1");
      if (has(el, "disabled")) return ok("disabled");
      if (isNativelyFocusable(el) || (ti != null && parseInt(ti, 10) >= 0)) return bad(`aria-hidden="true" on focusable <${el.tag}>`);
      return ok("not focusable");
    },
  },
  {
    id: "heading-order", target: "element", sc: "1.3.1", severity: "minor",
    summary: "Heading level skipped.",
    suggestion: "Do not skip heading levels; use CSS for visual size.",
    selects: (el) => /^h[1-6]$/.test(el.tag),
    check(el, ctx) {
      const hs = ctx.parsed.elements.filter((e) => /^h[1-6]$/.test(e.tag));
      const i = hs.indexOf(el);
      if (i <= 0) return ok("first heading");
      const prev = Number(hs[i - 1]!.tag[1]);
      const cur = Number(el.tag[1]);
      return cur > prev + 1 ? bad(`<h${cur}> follows <h${prev}>`) : ok(`h${prev}→h${cur}`);
    },
  },
  {
    id: "color-contrast", target: "css", sc: "1.4.3", severity: "serious",
    summary: "Text colour has insufficient contrast against its background.",
    suggestion: "Raise contrast to at least 4.5:1 (3:1 for large text).",
    check(rule) {
      const fg = rule.decls.get("color");
      const bgRaw = rule.decls.get("background-color") ?? rule.decls.get("background");
      if (!fg || !bgRaw) return null;
      const f = parseColor(fg);
      const b = parseColor(bgRaw);
      if (!f || !b || f[3] < 1 || b[3] < 1) return null;
      const ratio = contrastRatio(f, b);
      const need = isLargeText(rule.decls) ? 3 : 4.5;
      const r = ratio.toFixed(2);
      return ratio < need ? bad(`contrast ${r}:1 < ${need}:1 (${fg} on ${bgRaw})`) : ok(`contrast ${r}:1`);
    },
  },
  {
    id: "focus-outline-removed", target: "css", sc: "2.4.7", severity: "serious",
    summary: "Focus indicator removed without a replacement.",
    suggestion: "Keep an outline or provide another visible :focus-visible style (box-shadow, border).",
    check(rule) {
      if (!/:focus\b/.test(rule.selector) || /:focus:not\(:focus-visible\)/.test(rule.selector)) return null;
      const o = (rule.decls.get("outline") ?? rule.decls.get("outline-style") ?? "").trim();
      if (!/^(none|0|0px)$/.test(o)) return ok("outline kept");
      const replaced = ["box-shadow", "border", "border-color", "border-bottom", "background", "background-color", "text-decoration"].some((p) => rule.decls.has(p));
      return replaced ? ok("outline replaced by another style") : bad(`outline: ${o} with no replacement`);
    },
  },
];

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function buildCtx(parsed: Parsed): Ctx {
  const labelFor = new Set<string>();
  let dynamicLabelFor = false;
  for (const el of parsed.elements) {
    if (el.tag !== "label") continue;
    const f = el.attrs.get("for");
    if (f?.kind === "static") labelFor.add(f.value);
    else if (f?.kind === "dynamic") dynamicLabelFor = true;
  }
  return { parsed, labelFor, dynamicLabelFor };
}

/** Verbatim excerpt for an element: its opening tag (capped). */
export function openingTag(content: string, el: { start: number; end: number }): string {
  let q: string | null = null;
  let depth = 0;
  for (let i = el.start; i < Math.min(el.end, el.start + 400); i++) {
    const c = content[i]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth <= 0) return content.slice(el.start, i + 1);
  }
  return content.slice(el.start, Math.min(el.end, el.start + 300));
}

export function excerpt(parsed: Parsed, t: El | CssRule): string {
  const s = "tag" in t ? openingTag(parsed.content, t) : parsed.content.slice(t.start, Math.min(t.end, t.start + 300));
  return s.length > 500 ? s.slice(0, 500) : s;
}

export function runRules(parsed: Parsed, path: RepoPath): CandidateFinding[] {
  const ctx = buildCtx(parsed);
  const out: CandidateFinding[] = [];
  for (const rule of RULES) {
    const targets: (El | CssRule)[] = rule.target === "element" ? parsed.elements.filter((e) => !e.opaque && rule.selects(e)) : parsed.css;
    for (const t of targets) {
      const r = rule.target === "element" ? rule.check(t as El, ctx) : rule.check(t as CssRule, ctx);
      if (!r?.violates) continue;
      out.push({
        ruleId: rule.id, sc: rule.sc, severity: rule.severity, path, line: t.line,
        snippet: excerpt(parsed, t), message: `${rule.summary} ${r.detail}.`, suggestion: rule.suggestion, source: "rules",
      });
    }
  }
  return out;
}
