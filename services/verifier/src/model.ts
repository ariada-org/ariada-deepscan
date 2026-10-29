/**
 * Language-neutral element model. HTML, Vue/Svelte templates and JSX/TSX are
 * all parsed into this shape so that one set of deterministic rules (and one
 * verification algorithm) works for every framework.
 */
import type { ElementKind } from "@deepscan/contracts";

export type AttrVal =
  | { kind: "static"; value: string }
  | { kind: "dynamic" }
  | { kind: "boolean" };

export interface El {
  tag: string;
  /** lower-case, framework-normalised names (className→class, htmlFor→for, @click→onclick …) */
  attrs: Map<string, AttrVal>;
  hasSpread: boolean;
  /** true for capitalised JSX components / custom elements we cannot see into */
  opaque: boolean;
  start: number;
  end: number;
  line: number;
  parent: El | null;
  children: El[];
  /** concatenated static text (direct + descendants), whitespace-collapsed */
  text: string;
  /** some descendant text is produced by an expression / opaque component */
  hasDynamicContent: boolean;
  path: string;
}

export interface CssRule {
  selector: string;
  decls: Map<string, string>;
  start: number;
  end: number;
  line: number;
  path: string;
}

export interface Parsed {
  lang: "html" | "jsx" | "vue" | "svelte" | "css";
  content: string;
  elements: El[];
  css: CssRule[];
  lineOf(offset: number): number;
}

export function lineIndex(content: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export const attr = (el: El, name: string) => el.attrs.get(name);
export const has = (el: El, name: string) => el.attrs.has(name);
export function staticAttr(el: El, name: string): string | undefined {
  const a = el.attrs.get(name);
  return a?.kind === "static" ? a.value : undefined;
}
/** attribute present and (dynamic or non-empty static) */
export function hasNonEmpty(el: El, name: string): boolean {
  const a = el.attrs.get(name);
  if (!a) return false;
  if (a.kind === "dynamic") return true;
  if (a.kind === "boolean") return false;
  return a.value.trim().length > 0;
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "slider", "spinbutton", "textbox", "combobox", "searchbox", "treeitem", "gridcell",
]);
const LANDMARK_ROLES = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "region", "search", "form"]);

export function isNativelyFocusable(el: El): boolean {
  switch (el.tag) {
    case "a":
    case "area":
      return has(el, "href");
    case "button":
    case "select":
    case "textarea":
    case "iframe":
    case "summary":
      return true;
    case "input":
      return staticAttr(el, "type") !== "hidden";
    default:
      return false;
  }
}

export function hasClickHandler(el: El): boolean {
  return has(el, "onclick") || has(el, "onmousedown") || has(el, "onmouseup") || has(el, "onpointerdown");
}

/** Which kinds of element is this? (drives WCAG applicability) */
export function classify(el: El): ElementKind[] {
  const k = new Set<ElementKind>();
  const role = staticAttr(el, "role")?.trim().split(/\s+/)[0];
  const t = el.tag;
  if (["img", "svg", "picture", "area", "canvas"].includes(t) || role === "img" || (t === "input" && staticAttr(el, "type") === "image")) k.add("img");
  if (["video", "audio", "object", "embed"].includes(t)) k.add("media");
  if ((t === "a" && has(el, "href")) || role === "link") k.add("link");
  if (t === "button" || role === "button" || (t === "input" && ["button", "submit", "reset"].includes(staticAttr(el, "type") ?? ""))) k.add("button");
  if (
    t === "select" || t === "textarea" ||
    (t === "input" && !["button", "submit", "reset", "image", "hidden"].includes(staticAttr(el, "type") ?? "text")) ||
    ["textbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "searchbox"].includes(role ?? "")
  ) k.add("form-control");
  if (/^h[1-6]$/.test(t) || role === "heading") k.add("heading");
  if (["html", "head", "title", "meta", "body", "base"].includes(t)) k.add("document");
  if (t === "iframe" || t === "frame") k.add("frame");
  if (["table", "thead", "tbody", "tr", "th", "td", "caption"].includes(t)) k.add("table");
  if (["ul", "ol", "li", "dl", "dt", "dd"].includes(t)) k.add("list");
  if (["nav", "main", "header", "footer", "aside", "form", "section"].includes(t) || LANDMARK_ROLES.has(role ?? "")) k.add("landmark");
  if (hasClickHandler(el) || has(el, "tabindex") || (role && INTERACTIVE_ROLES.has(role)) || isNativelyFocusable(el)) k.add("interactive");
  if (has(el, "style")) k.add("style");
  if (el.text.length > 0 || el.hasDynamicContent || k.size === 0) k.add("text");
  return [...k];
}
