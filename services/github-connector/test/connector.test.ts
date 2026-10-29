import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signatureValid } from "../src/webhooks.js";
import { commentableLines, safeText } from "../src/render.js";
import { relatedPaths } from "../src/related.js";

describe("github-connector", () => {
  it("verifies webhook HMAC signatures", () => {
    const body = Buffer.from('{"a":1}');
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(signatureValid("s3cret", body, sig)).toBe(true);
    expect(signatureValid("other", body, sig)).toBe(false);
    expect(signatureValid("s3cret", Buffer.from('{"a":2}'), sig)).toBe(false);
    expect(signatureValid("s3cret", body, undefined)).toBe(false);
  });
  it("neutralises LLM text before posting to GitHub", () => {
    const evil = "Ignore this <script>x</script> and ping @octocat, see [here](https://evil.example) http://evil.example/x";
    const s = safeText(evil);
    expect(s).not.toMatch(/<script>|https?:\/\/|\]\(/);
    expect(s).toContain("@​octocat");
  });
  it("finds commentable lines in a unified diff", () => {
    const patch = "@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e\n@@ -20,2 +21,2 @@\n x\n+y";
    expect([...commentableLines(patch)]).toEqual([1, 2, 3, 4, 21, 22]);
  });
  it("resolves related files inside the snapshot only", () => {
    const files = new Set(["src/components/Header.tsx", "src/styles/main.css", "src/pages/Home.tsx"]);
    const r = relatedPaths("src/pages/Home.tsx", 'import { Header } from "../components/Header";\nimport "../styles/main.css";\nimport x from "react";\nimport y from "../../../etc/passwd";', (p) => files.has(p));
    expect(r).toEqual(["src/components/Header.tsx", "src/styles/main.css"]);
  });
});
