import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { CandidateFinding, RepoPath } from "@deepscan/contracts";
import { parseSource } from "../src/parse.js";
import { runRules } from "../src/rules.js";
import { verifyCandidate } from "../src/verify.js";
import { evaluatePolicy } from "../src/policy.js";

const root = new URL("../../../fixtures/demo-site/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const P = (p: string) => p as RepoPath;

function llm(p: string, o: Partial<CandidateFinding>): CandidateFinding {
  return { ruleId: null, sc: "1.1.1", severity: "serious", path: P(p), line: 1, snippet: "", message: "", suggestion: null, source: "llm", ...o };
}

describe("rules engine", () => {
  it("finds the seeded defects in index.html", () => {
    const ids = runRules(parseSource("index.html", read("index.html")), P("index.html")).map((c) => c.ruleId).sort();
    expect(ids).toEqual(["click-non-interactive", "form-control-label", "heading-order", "html-lang", "img-alt", "img-alt-suspicious", "link-name", "link-name", "link-text-generic", "meta-viewport-zoom"]);
  });
  it("does not guess on dynamic values (svelte {alt}, vue :alt)", () => {
    for (const p of ["src/components/Gallery.svelte", "src/components/Modal.vue"]) {
      const c = runRules(parseSource(p, read(p)), P(p));
      expect(c.filter((x) => x.ruleId === "img-alt")).toHaveLength(0);
    }
  });
  it("respects label[for] and box-shadow focus replacements", () => {
    expect(runRules(parseSource("about.html", read("about.html")), P("about.html")).some((c) => c.ruleId === "form-control-label")).toBe(false);
    expect(runRules(parseSource("src/styles/theme.css", read("src/styles/theme.css")), P("src/styles/theme.css"))).toHaveLength(0);
  });
});

describe("verifier", () => {
  const path = "index.html";
  const content = read(path);
  const parsed = parseSource(path, content);

  it("verifies rule findings by recomputation", () => {
    for (const c of runRules(parsed, P(path))) {
      const v = verifyCandidate(parsed, c);
      expect(v.status, c.ruleId!).toBe("verified");
      expect(v.method).toBe("recomputed");
      expect(v.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    }
  });

  it("rejects a hallucinated snippet", () => {
    const v = verifyCandidate(parsed, llm(path, { snippet: '<img src="assets/banner.png">', message: "Banner image has no alt", line: 30 }));
    expect(v.status).toBe("rejected");
    expect(v.reason).toMatch(/hallucinated/);
  });

  it("rejects a claim contradicted by a deterministic check", () => {
    const p = "about.html";
    const pa = parseSource(p, read(p));
    const v = verifyCandidate(pa, llm(p, { snippet: '<textarea id="msg" name="msg">', sc: "4.1.2", message: "Textarea is missing a label.", line: 14 }));
    expect(v.status).toBe("rejected");
    expect(v.reason).toMatch(/contradicted/);
  });

  it("rejects a criterion that does not apply to the element", () => {
    const v = verifyCandidate(parsed, llm(path, { snippet: '<button type="submit">Subscribe</button>', sc: "3.1.1", message: "Language of page not set", line: 24 }));
    expect(v.status).toBe("rejected");
    expect(v.checks.find((c) => c.name === "sc-applicable")?.ok).toBe(false);
  });

  it("marks grounded semantic findings as unverifiable", () => {
    const v = verifyCandidate(parsed, llm(path, { snippet: "<h1>Gear for every season</h1>", sc: "2.4.6", severity: "minor", message: "Heading does not describe the page topic well.", line: 18 }));
    expect(v.status).toBe("unverifiable");
    expect(v.method).toBe("grounded");
  });

  it("an LLM finding reproduced by a rule gets the same fingerprint as the rule finding (dedup)", () => {
    const rule = runRules(parsed, P(path)).find((c) => c.ruleId === "img-alt")!;
    const a = verifyCandidate(parsed, rule);
    const b = verifyCandidate(parsed, llm(path, { snippet: '<img src="assets/logo.svg">', message: "Logo image lacks a text alternative", line: 12 }));
    expect(b.status).toBe("verified");
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("fingerprints are stable when lines shift (baseline matching)", () => {
    const shifted = content.replace("<body>", "<body>\n\n\n<p>Banner</p>");
    const ps = parseSource(path, shifted);
    const f1 = runRules(parsed, P(path)).map((c) => verifyCandidate(parsed, c).fingerprint).sort();
    const f2 = runRules(ps, P(path)).map((c) => verifyCandidate(ps, c).fingerprint).sort();
    expect(f2).toEqual(f1);
  });
});

describe("policy", () => {
  it("fails only on verified regressions with blocking severity", () => {
    expect(evaluatePolicy({ findings: [{ severity: "critical", status: "verified", diff: "persistent" }] }, ["critical"]).conclusion).toBe("success");
    expect(evaluatePolicy({ findings: [{ severity: "critical", status: "verified", diff: "regression" }] }, ["critical"]).conclusion).toBe("failure");
    expect(evaluatePolicy({ findings: [{ severity: "critical", status: "unverifiable", diff: "regression" }] }, ["critical"]).conclusion).toBe("neutral");
  });
});
