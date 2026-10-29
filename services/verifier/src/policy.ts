/** Policy gate: only *new* (regression), verified findings can fail a PR. */
import type { Severity } from "@deepscan/contracts";
import type { z } from "zod";
import type { PolicyEvaluateRequest, PolicyEvaluateResponse } from "@deepscan/contracts";

export function evaluatePolicy(
  req: z.output<typeof PolicyEvaluateRequest>,
  failOn: Severity[],
): z.output<typeof PolicyEvaluateResponse> {
  const regressions = req.findings.filter((f) => f.diff === "regression" && f.status !== "rejected");
  const blocking = regressions.filter((f) => f.status === "verified" && failOn.includes(f.severity));
  const review = regressions.filter((f) => f.status === "unverifiable");
  const resolved = req.findings.filter((f) => f.diff === "resolved" && f.status !== "rejected").length;
  const persistent = req.findings.filter((f) => f.diff === "persistent" && f.status !== "rejected").length;
  const summary = [
    `**${regressions.length}** new accessibility issue(s): ${blocking.length} blocking (${failOn.join("/")}), ${review.length} need human review.`,
    `**${resolved}** resolved, **${persistent}** pre-existing (not blocking).`,
  ].join("\n");
  if (blocking.length > 0) return { conclusion: "failure", title: `${blocking.length} blocking accessibility regression(s)`, summary };
  if (review.length > 0) return { conclusion: "neutral", title: `${review.length} new issue(s) need review`, summary };
  return { conclusion: "success", title: regressions.length ? "No blocking accessibility regressions" : "No new accessibility issues", summary };
}
