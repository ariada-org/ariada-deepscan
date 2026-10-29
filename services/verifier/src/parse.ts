import { parse as parseHtmlDoc, parseFragment } from "parse5";
import { parse as parseJs } from "@babel/parser";
import postcss from "postcss";
import { type El, type AttrVal, type CssRule, type Parsed, lineIndex } from "./model.js";

export type Lang = Parsed["lang"];

export function detectLang(path: string): Lang | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (["html", "htm", "xhtml"].includes(ext)) return "html";
  if (["jsx", "tsx", "js", "mjs"].includes(ext)) return "jsx";
  if (ext === "vue") return "vue";
  if (ext === "svelte") return "svelte";
  if (["css", "scss"].includes(ext)) return "css";
  return null;
}

export function parseSource(path: string, raw: string): Parsed {
  const content = raw.replace(/\r\n?/g, "\n");
  const lang = detectLang(path) ?? "html";
  const lineOf = lineIndex(content);
  const b = new Builder(content, lineOf);
  switch (lang) {
    case "html":
      b.html(content, 0, /<html[\s>]|<!doctype/i.test(content));
      break;
    case "vue": {
      const open = /<template(\s[^>]*)?>/i.exec(content);
      const close = content.lastIndexOf("</template>");
      if (open && close > open.index) {
        const start = open.index + open[0].length;
        b.html(content.slice(start, close), start, false, "vue");
      }
      b.styleBlocks(content);
      break;
    }
    case "svelte": {
      // blank out <script>/<style> blocks (keep offsets), parse the rest as markup
      const masked = content.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " "));
      b.html(masked, 0, false, "svelte");
      b.styleBlocks(content);
      break;
    }
    case "jsx":
      b.jsx(content, /\.tsx?$/i.test(path));
      break;
    case "css":
      b.css(content, 0, "");
      break;
  }
  b.finish();
  return { lang, content, elements: b.elements, css: b.cssRules, lineOf };
}

/* ------------------------------------------------------------------------- */

type Flavor = "html" | "vue" | "svelte";

interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  content?: P5Node;
  sourceCodeLocation?: { startOffset: number; endOffset: number; startLine: number } | null;
}

class Builder {
  elements: El[] = [];
  roots: El[] = [];
  cssRules: CssRule[] = [];
  private directText = new Map<El, string[]>();
  private directDynamic = new Set<El>();

  constructor(private content: string, private lineOf: (o: number) => number) {}

  private newEl(tag: string, start: number, end: number, parent: El | null, opaque: boolean): El {
    const el: El = {
      tag, attrs: new Map(), hasSpread: false, opaque, start, end, line: this.lineOf(start),
      parent, children: [], text: "", hasDynamicContent: false, path: "",
    };
    if (parent) parent.children.push(el);
    else this.roots.push(el);
    this.elements.push(el);
    return el;
  }

  private addText(el: El | null, t: string) {
    if (!el) return;
    const arr = this.directText.get(el) ?? [];
    arr.push(t);
    this.directText.set(el, arr);
  }
  private markDynamic(el: El | null) {
    if (el) this.directDynamic.add(el);
  }

  /* ---------- HTML / Vue / Svelte ---------- */
  html(src: string, base: number, document: boolean, flavor: Flavor = "html") {
    const opts = { sourceCodeLocationInfo: true } as const;
    const tree = (document ? parseHtmlDoc(src, opts) : parseFragment(src, opts)) as unknown as P5Node;
    const walk = (n: P5Node, parent: El | null) => {
      for (const c of n.childNodes ?? []) {
        if (c.nodeName === "#text") {
          const v = c.value ?? "";
          if (/\{\{[\s\S]*?\}\}/.test(v) || (flavor === "svelte" && /\{[^}]*\}/.test(v))) this.markDynamic(parent);
          const stripped = v.replace(/\{\{[\s\S]*?\}\}/g, " ").replace(flavor === "svelte" ? /\{[^}]*\}/g : /$^/, " ");
          if (parent && ["script", "style", "noscript"].includes(parent.tag)) {
            if (parent.tag === "style" && c.sourceCodeLocation) this.css(v, base + c.sourceCodeLocation.startOffset, "");
            continue;
          }
          this.addText(parent, stripped);
          continue;
        }
        if (c.nodeName.startsWith("#")) continue; // comments, doctype
        const loc = c.sourceCodeLocation;
        if (!loc) {
          // implicit element inserted by the parser (e.g. <html>/<body> in a fragment-less document)
          walk(c, parent);
          if (c.content) walk(c.content, parent);
          continue;
        }
        const tag = (c.tagName ?? c.nodeName).toLowerCase();
        const opaque = tag.includes("-") || tag === "slot" || (flavor !== "html" && /^[A-Z]/.test(this.content.slice(base + loc.startOffset + 1, base + loc.startOffset + 2)));
        const el = this.newEl(tag, base + loc.startOffset, base + loc.endOffset, parent, opaque);
        for (const a of c.attrs ?? []) this.htmlAttr(el, a.name, a.value, flavor);
        walk(c, el);
        if (c.content) walk(c.content, el); // <template> content
      }
    };
    walk(tree, null);
  }

  private htmlAttr(el: El, rawName: string, value: string, flavor: Flavor) {
    let name = rawName.toLowerCase();
    let dynamic = /\{\{[\s\S]*?\}\}/.test(value);
    if (flavor === "vue") {
      if (name === "v-bind" ) { el.hasSpread = true; return; }
      if (name === "v-html" || name === "v-text") { this.markDynamic(el); return; }
      if (name.startsWith(":")) { name = name.slice(1); dynamic = true; }
      else if (name.startsWith("v-bind:")) { name = name.slice(7); dynamic = true; }
      else if (name.startsWith("@")) { name = "on" + name.slice(1).split(".")[0]; dynamic = true; }
      else if (name.startsWith("v-on:")) { name = "on" + name.slice(5).split(".")[0]; dynamic = true; }
      else if (name.startsWith("v-")) return;
    }
    if (flavor === "svelte") {
      if (/^\{\.\.\./.test(name)) { el.hasSpread = true; return; }
      const short = /^\{(\w+)\}$/.exec(name);
      if (short) { name = short[1]!.toLowerCase(); dynamic = true; }
      if (name.startsWith("on:")) { name = "on" + name.slice(3).split("|")[0]; dynamic = true; }
      else if (name.startsWith("bind:")) { name = name.slice(5); dynamic = true; }
      else if (name.startsWith("class:") || name.startsWith("use:") || name.startsWith("transition:")) return;
      if (/^\{[\s\S]*\}$/.test(value.trim())) dynamic = true;
    }
    // Angular-style bindings in plain HTML templates
    if (name.startsWith("[") && name.endsWith("]")) { name = name.slice(1, -1).replace(/^attr\./, ""); dynamic = true; }
    if (name.startsWith("(") && name.endsWith(")")) { name = "on" + name.slice(1, -1); dynamic = true; }
    const v: AttrVal = dynamic ? { kind: "dynamic" } : value === "" && !["alt", "value", "title", "aria-label"].includes(name) ? { kind: "boolean" } : { kind: "static", value };
    el.attrs.set(name, v);
  }

  styleBlocks(content: string) {
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) this.css(m[1]!, m.index + m[0].indexOf(">") + 1, "");
  }

  /* ---------- CSS ---------- */
  css(src: string, base: number, prefix: string) {
    let root: postcss.Root;
    try {
      root = postcss.parse(src);
    } catch {
      return;
    }
    const seen = new Map<string, number>();
    root.walkRules((rule) => {
      const decls = new Map<string, string>();
      rule.each((n) => {
        if (n.type === "decl") decls.set(n.prop.toLowerCase(), n.value.trim());
      });
      if (decls.size === 0) return;
      let ctx = "";
      let p = rule.parent;
      while (p && p.type === "atrule") {
        ctx = `@${(p as postcss.AtRule).name} ${(p as postcss.AtRule).params}>` + ctx;
        p = p.parent;
      }
      const sel = rule.selector.replace(/\s+/g, " ").trim();
      const key = prefix + ctx + sel;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const start = base + (rule.source?.start?.offset ?? 0);
      const end = base + (rule.source?.end?.offset ?? src.length);
      this.cssRules.push({ selector: sel, decls, start, end: end + 1, line: this.lineOf(start), path: `css:${key}${n > 1 ? `#${n}` : ""}` });
    });
  }

  /* ---------- JSX / TSX ---------- */
  jsx(src: string, ts: boolean) {
    let ast: unknown;
    try {
      ast = parseJs(src, {
        sourceType: "module",
        errorRecovery: true,
        plugins: ts ? ["jsx", "typescript", "decorators-legacy"] : ["jsx", "flow", "decorators-legacy"],
      });
    } catch {
      return;
    }
    const SKIP = new Set(["loc", "start", "end", "range", "extra", "leadingComments", "trailingComments", "innerComments", "comments", "tokens"]);
    type N = { type?: string; [k: string]: unknown };
    const isNode = (x: unknown): x is N => !!x && typeof x === "object" && typeof (x as N).type === "string";

    const generic = (n: unknown, parent: El | null) => {
      if (Array.isArray(n)) {
        for (const c of n) generic(c, parent);
        return;
      }
      if (!isNode(n)) {
        if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) if (!SKIP.has(k)) generic(v, parent);
        return;
      }
      if (n.type === "JSXElement") return element(n, parent);
      if (n.type === "JSXFragment") return children(n.children as N[], parent);
      for (const [k, v] of Object.entries(n)) if (!SKIP.has(k)) generic(v, parent);
    };

    const nameOf = (n: N): string => {
      if (n.type === "JSXIdentifier") return n.name as string;
      if (n.type === "JSXMemberExpression") return `${nameOf(n.object as N)}.${nameOf(n.property as N)}`;
      if (n.type === "JSXNamespacedName") return `${nameOf(n.namespace as N)}:${nameOf(n.name as N)}`;
      return "?";
    };

    const staticString = (e: N): string | null => {
      if (e.type === "StringLiteral") return e.value as string;
      if (e.type === "NumericLiteral") return String(e.value);
      if (e.type === "BooleanLiteral") return String(e.value);
      if (e.type === "TemplateLiteral" && (e.expressions as unknown[]).length === 0)
        return ((e.quasis as N[])[0]?.value as { cooked: string })?.cooked ?? "";
      return null;
    };

    const styleObject = (e: N): string | null => {
      if (e.type !== "ObjectExpression") return null;
      const parts: string[] = [];
      for (const p of e.properties as N[]) {
        if (p.type !== "ObjectProperty") return null;
        const key = (p.key as N).type === "Identifier" ? ((p.key as N).name as string) : staticString(p.key as N);
        const val = staticString(p.value as N);
        if (key == null || val == null) return null;
        parts.push(`${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}: ${val}`);
      }
      return parts.join("; ");
    };

    const element = (n: N, parent: El | null) => {
      const open = n.openingElement as N;
      const name = nameOf(open.name as N);
      const intrinsic = /^[a-z][a-z0-9]*(-[a-z0-9-]+)?$/.test(name);
      const el = this.newEl(intrinsic ? name : name, n.start as number, n.end as number, parent, !intrinsic || name.includes("-"));
      for (const a of open.attributes as N[]) {
        if (a.type === "JSXSpreadAttribute") {
          el.hasSpread = true;
          generic(a.argument, parent);
          continue;
        }
        let an = nameOf(a.name as N);
        if (an === "className") an = "class";
        else if (an === "htmlFor") an = "for";
        an = an.toLowerCase();
        const v = a.value as N | null;
        if (v == null) el.attrs.set(an, { kind: "boolean" });
        else if (v.type === "StringLiteral") el.attrs.set(an, { kind: "static", value: v.value as string });
        else if (v.type === "JSXExpressionContainer") {
          const e = v.expression as N;
          const s = staticString(e) ?? (an === "style" ? styleObject(e) : null);
          el.attrs.set(an, s == null ? { kind: "dynamic" } : { kind: "static", value: s });
          if (s == null) generic(e, parent);
        } else el.attrs.set(an, { kind: "dynamic" });
      }
      children(n.children as N[], el);
    };

    const children = (kids: N[], el: El | null) => {
      for (const c of kids) {
        if (c.type === "JSXText") this.addText(el, c.value as string);
        else if (c.type === "JSXElement") element(c, el);
        else if (c.type === "JSXFragment") children(c.children as N[], el);
        else if (c.type === "JSXExpressionContainer") {
          const e = c.expression as N;
          if (e.type === "JSXEmptyExpression") continue;
          const s = staticString(e);
          if (s != null) this.addText(el, s);
          else {
            this.markDynamic(el);
            generic(e, el);
          }
        } else if (c.type === "JSXSpreadChild") this.markDynamic(el);
      }
    };

    generic(ast, null);
  }

  /* ---------- post-processing ---------- */
  finish() {
    const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
    const visit = (el: El) => {
      let text = (this.directText.get(el) ?? []).join(" ");
      let dyn = this.directDynamic.has(el);
      for (const c of el.children) {
        visit(c);
        text += " " + c.text;
        dyn = dyn || c.hasDynamicContent || c.opaque;
      }
      el.text = collapse(text);
      el.hasDynamicContent = dyn;
    };
    for (const r of this.roots) visit(r);
    const assign = (list: El[], prefix: string) => {
      const counts = new Map<string, number>();
      for (const el of list) {
        const n = (counts.get(el.tag) ?? 0) + 1;
        counts.set(el.tag, n);
        el.path = `${prefix}${el.tag}:${n}`;
        assign(el.children, el.path + ">");
      }
    };
    assign(this.roots, "");
    // inline style="" → pseudo CSS rules so contrast rules see them
    for (const el of this.elements) {
      const st = el.attrs.get("style");
      if (st?.kind === "static") {
        try {
          const root = postcss.parse(`x{${st.value}}`);
          const decls = new Map<string, string>();
          root.walkDecls((d) => void decls.set(d.prop.toLowerCase(), d.value.trim()));
          if (decls.size) this.cssRules.push({ selector: `[inline:${el.path}]`, decls, start: el.start, end: el.end, line: el.line, path: `inline:${el.path}` });
        } catch {
          /* ignore malformed inline style */
        }
      }
    }
  }
}
