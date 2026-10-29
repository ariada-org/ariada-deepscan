import { describe, it, expect } from "vitest";
import { parseToolCall, toolDefinitions, RepoPath, parseGithubUrl, WcagSc, scApplies } from "../src/index.js";

describe("type-safe contract layer", () => {
  it("rejects invented WCAG criteria in tool calls (repair loop input)", () => {
    const r = parseToolCall("report_finding", { ruleId: null, sc: "9.9.9", severity: "serious", line: 1, snippet: "<img>", message: "x", suggestion: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/schema violation: sc/);
  });
  it("rejects unknown tools and path traversal", () => {
    expect(parseToolCall("exec_shell", {}).ok).toBe(false);
    expect(parseToolCall("read_file", { path: "../../etc/passwd" }).ok).toBe(false);
    expect(parseToolCall("read_file", { path: "/etc/passwd" }).ok).toBe(false);
    expect(parseToolCall("read_file", { path: "src/App.tsx" }).ok).toBe(true);
  });
  it("generates JSON-schema tool definitions from the same Zod schemas", () => {
    const defs = toolDefinitions();
    const report = defs.find((d) => d.name === "report_finding")!;
    const sc = (report.inputSchema as { properties: { sc: { enum: string[] } } }).properties.sc;
    expect(sc.enum).toContain("1.4.3");
    expect(sc.enum).not.toContain("4.1.1"); // removed in WCAG 2.2
    expect(defs.map((d) => d.name)).toEqual(["search_wcag", "get_sc", "read_file", "list_related", "run_rules", "report_finding", "finish"]);
  });
  it("only accepts https://github.com/{owner}/{repo} (SSRF guard)", () => {
    expect(parseGithubUrl("https://github.com/w3c/wcag")).toBe("w3c/wcag");
    expect(parseGithubUrl("https://github.com/w3c/wcag.git")).toBe("w3c/wcag");
    for (const bad of ["http://github.com/a/b", "https://github.com.evil.io/a/b", "https://github.com/a/b/../../c", "https://169.254.169.254/a/b", "https://github.com/a"]) expect(parseGithubUrl(bad)).toBeNull();
  });
  it("knows which criteria apply to which elements", () => {
    expect(WcagSc.options).toHaveLength(86);
    expect(scApplies("3.1.1", ["button"])).toBe(false);
    expect(scApplies("4.1.2", ["button"])).toBe(true);
    expect(RepoPath.safeParse("a//b").success).toBe(false);
  });
});
