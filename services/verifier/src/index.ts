import { z } from "zod";
import {
  RulesRunRequest, RulesRunResponse, VerifyRequest, VerifyResponse,
  PolicyEvaluateRequest, PolicyEvaluateResponse, Severity,
} from "@deepscan/contracts";
import { BaseEnv, loadEnv, createService, listen, counter } from "@deepscan/platform";
import { parseSource } from "./parse.js";
import { runRules, buildCtx } from "./rules.js";
import { verifyCandidate } from "./verify.js";
import { evaluatePolicy } from "./policy.js";

const env = loadEnv(
  BaseEnv.extend({
    POLICY_FAIL_ON: z.string().default("critical,serious").transform((s) => z.array(Severity).parse(s.split(",").map((x) => x.trim()).filter(Boolean))),
  }),
);
const verdicts = counter("verifier_verdicts_total", "Verdicts issued, by status and source");

const app = await createService({ name: "verifier", podName: env.POD_NAME, logLevel: env.LOG_LEVEL, bodyLimit: 8 * 1024 * 1024 });

app.post("/rules/run", { schema: { body: RulesRunRequest, response: { 200: RulesRunResponse } } }, async (req) => {
  const parsed = parseSource(req.body.path, req.body.content);
  return { candidates: runRules(parsed, req.body.path) };
});

app.post("/verify", { schema: { body: VerifyRequest, response: { 200: VerifyResponse } } }, async (req) => {
  const parsed = parseSource(req.body.path, req.body.content);
  const ctx = buildCtx(parsed);
  const results = req.body.candidates.map((candidate) => {
    const verdict = candidate.path === req.body.path
      ? verifyCandidate(parsed, candidate, ctx)
      : { status: "rejected" as const, method: "none" as const, reason: "Finding refers to a different file.", checks: [], fingerprint: null, line: candidate.line, elementPath: null, elementKinds: [], selectorHint: null };
    verdicts.inc({ status: verdict.status, source: candidate.source });
    return { candidate, verdict };
  });
  req.log.info({ path: req.body.path, n: results.length, verified: results.filter((r) => r.verdict.status === "verified").length, rejected: results.filter((r) => r.verdict.status === "rejected").length }, "verified batch");
  return { results };
});

app.post("/policy/evaluate", { schema: { body: PolicyEvaluateRequest, response: { 200: PolicyEvaluateResponse } } }, async (req) =>
  evaluatePolicy(req.body, env.POLICY_FAIL_ON),
);

await listen(app, env.PORT);
