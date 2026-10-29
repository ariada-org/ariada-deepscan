import { z } from "zod";
import { WcagSc, ElementKind } from "./wcag.js";
import { RepoPath, Fingerprint } from "./ids.js";

export const Severity = z.enum(["critical", "serious", "moderate", "minor"]);
export type Severity = z.infer<typeof Severity>;

export const RuleId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60);

/** A finding proposed by the rules engine or by the LLM — not yet trusted. */
export const CandidateFinding = z.object({
  ruleId: RuleId.nullable().describe("Deterministic rule id if known (e.g. 'img-alt'), else null"),
  sc: WcagSc.describe("WCAG 2.2 success criterion, e.g. '1.1.1'"),
  severity: Severity,
  path: RepoPath,
  line: z.number().int().min(1).describe("1-based line where the snippet starts"),
  snippet: z.string().min(1).max(500).describe("Exact, verbatim excerpt of the offending code"),
  message: z.string().min(1).max(600),
  suggestion: z.string().max(1000).nullable().default(null),
  source: z.enum(["rules", "llm"]),
});
export type CandidateFinding = z.infer<typeof CandidateFinding>;

export const VerdictStatus = z.enum(["verified", "rejected", "unverifiable"]);
export type VerdictStatus = z.infer<typeof VerdictStatus>;

export const Verdict = z.object({
  status: VerdictStatus,
  /** recomputed = a deterministic check re-derived the violation; grounded = snippet/element/SC are real but semantics cannot be checked */
  method: z.enum(["recomputed", "grounded", "none"]),
  reason: z.string(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
  fingerprint: Fingerprint.nullable(),
  line: z.number().int().min(1),
  elementPath: z.string().nullable(),
  elementKinds: z.array(ElementKind),
  selectorHint: z.string().nullable(),
});
export type Verdict = z.infer<typeof Verdict>;

export const DiffClass = z.enum(["regression", "resolved", "persistent"]);
export type DiffClass = z.infer<typeof DiffClass>;

export const FindingRecord = CandidateFinding.extend({
  id: z.number().int(),
  status: VerdictStatus,
  method: Verdict.shape.method,
  reason: z.string(),
  fingerprint: Fingerprint.nullable(),
  selectorHint: z.string().nullable(),
  workerPod: z.string().nullable(),
});
export type FindingRecord = z.infer<typeof FindingRecord>;
