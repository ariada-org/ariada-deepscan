/** WCAG relative luminance / contrast ratio for literal CSS colours. */
export type RGBA = [number, number, number, number];

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", gainsboro: "#dcdcdc", whitesmoke: "#f5f5f5", orange: "#ffa500",
  navy: "#000080", maroon: "#800000", purple: "#800080", teal: "#008080", olive: "#808000", lime: "#00ff00",
  aqua: "#00ffff", fuchsia: "#ff00ff", pink: "#ffc0cb", beige: "#f5f5dc", ivory: "#fffff0", khaki: "#f0e68c",
};

export function parseColor(input: string): RGBA | null {
  let v = input.trim().toLowerCase().replace(/\s*!important$/, "");
  if (NAMED[v]) v = NAMED[v]!;
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  return null;
}

function lum([r, g, b]: RGBA): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: RGBA, b: RGBA): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** "large text" per WCAG: ≥ 24px, or ≥ 18.66px and bold. Unknown → false (strict threshold). */
export function isLargeText(decls: Map<string, string>): boolean {
  const fs = decls.get("font-size");
  if (!fs) return false;
  let px: number | null = null;
  const m = /^([\d.]+)(px|rem|em|pt)$/.exec(fs.trim());
  if (m) {
    const n = parseFloat(m[1]!);
    px = m[2] === "px" ? n : m[2] === "pt" ? (n * 4) / 3 : n * 16;
  }
  if (px == null) return false;
  const w = decls.get("font-weight") ?? "";
  const bold = w === "bold" || w === "bolder" || parseInt(w, 10) >= 700;
  return px >= 24 || (bold && px >= 18.66);
}
