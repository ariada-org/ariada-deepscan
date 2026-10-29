/**
 * REST contracts for every service. Servers validate requests/serialise
 * responses with these schemas (and publish them as OpenAPI); clients validate
 * the responses they receive. One definition, both sides.
 */
import { z } from "zod";
import { WcagSc, ElementKind } from "./wcag.js";
import { RepoPath, ScanId, RepoId, GitSha, RepoFullName, Fingerprint } from "./ids.js";
import { CandidateFinding, Verdict, Severity, VerdictStatus, DiffClass, FindingRecord } from "./findings.js";

export const ErrorResponse = z.object({ error: z.string(), detail: z.unknown().optional() });

/* ---------------- verifier ---------------- */
export const RulesRunRequest = z.object({ path: RepoPath, content: z.string().max(2_000_000) });
export const RulesRunResponse = z.object({ candidates: z.array(CandidateFinding) });

export const VerifyRequest = z.object({
  path: RepoPath,
  content: z.string().max(2_000_000),
  candidates: z.array(CandidateFinding).max(200),
});
export const VerifyResponse = z.object({
  results: z.array(z.object({ candidate: CandidateFinding, verdict: Verdict })),
});

export const PolicyEvaluateRequest = z.object({
  findings: z.array(z.object({ severity: Severity, status: VerdictStatus, diff: DiffClass })),
});
export const PolicyEvaluateResponse = z.object({
  conclusion: z.enum(["success", "failure", "neutral"]),
  title: z.string(),
  summary: z.string(),
});

/* ---------------- rag-service ---------------- */
export const RagDocKind = z.enum(["sc", "understanding", "technique", "failure", "aria"]);
export const SearchRequest = z.object({
  query: z.string().min(2).max(300),
  k: z.number().int().min(1).max(10).default(4),
  kinds: z.array(RagDocKind).optional(),
});
export const SearchHit = z.object({
  id: z.string(),
  kind: RagDocKind,
  sc: z.array(WcagSc),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  score: z.number(),
});
export const SearchResponse = z.object({ hits: z.array(SearchHit), mode: z.string() });
export const ScDetail = z.object({
  sc: WcagSc,
  title: z.string(),
  level: z.enum(["A", "AA", "AAA"]),
  appliesTo: z.union([z.array(ElementKind), z.literal("any")]),
  summary: z.string(),
  url: z.string(),
  related: z.array(z.object({ id: z.string(), kind: RagDocKind, title: z.string() })),
});

/* ---------------- github-connector ---------------- */
export const FileContentResponse = z.object({
  path: RepoPath,
  sha: z.string(),
  size: z.number().int(),
  content: z.string(),
});
export const RelatedFilesResponse = z.object({ path: RepoPath, related: z.array(RepoPath) });
export const CreateScanRequest = z.union([
  z.object({ repoUrl: z.string().max(200), ref: z.string().max(200).optional() }),
  z.object({ repoId: RepoId, ref: z.string().max(200).optional() }),
]);
export const CreateScanResponse = z.object({ scanId: ScanId, repoId: RepoId, status: z.string() });

/* ---------------- findings-api (read side) ---------------- */
export const ScanKind = z.enum(["full", "pr"]);
export const ScanStatus = z.enum(["ingesting", "queued", "running", "completed", "failed"]);
export const FileStatus = z.enum(["queued", "analyzing", "done", "error", "skipped"]);

export const Me = z.object({
  authenticated: z.boolean(),
  login: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  installations: z.array(z.number().int()),
  publicScansEnabled: z.boolean(),
});

export const RepoSummary = z.object({
  id: RepoId,
  fullName: RepoFullName,
  defaultBranch: z.string(),
  siteUrl: z.string().nullable(),
  source: z.enum(["github-app", "public", "fixture"]),
  lastScan: z.object({ id: ScanId, status: ScanStatus, createdAt: z.string() }).nullable(),
});
export const ReposResponse = z.object({ repos: z.array(RepoSummary) });

export const ScanSummary = z.object({
  id: ScanId,
  repoId: RepoId,
  repoFullName: RepoFullName,
  kind: ScanKind,
  status: ScanStatus,
  ref: z.string(),
  headSha: GitSha,
  baseScanId: ScanId.nullable(),
  prNumber: z.number().int().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export const ScansResponse = z.object({ scans: z.array(ScanSummary) });

export const FileNode = z.object({
  path: RepoPath,
  status: FileStatus,
  workerPod: z.string().nullable(),
  verified: z.number().int(),
  /** the most severe verified finding in the file; null when none is verified. Colours the dashboard ribbon. */
  worstSeverity: Severity.nullable(),
  unverifiable: z.number().int(),
  rejected: z.number().int(),
  durationMs: z.number().int().nullable(),
  cacheHit: z.boolean(),
  error: z.string().nullable(),
});
export const TreeResponse = z.object({ scan: ScanSummary, files: z.array(FileNode) });

export const ProgressResponse = z.object({
  scanId: ScanId,
  status: ScanStatus,
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  pods: z.array(z.object({ pod: z.string(), files: z.number().int() })),
  findings: z.record(z.string(), z.number().int()),
  elapsedMs: z.number().int(),
  /** while the scan runs: where the model runs and how busy that hardware is (null fields: not known) */
  model: z.object({
    runsOn: z.enum(["mock", "host", "cluster"]),
    name: z.string().nullable(),
    device: z.enum(["gpu", "cpu"]).nullable(),
    /** busy share of the host's GPU or CPU, percent */
    pct: z.number().nullable(),
    /** CPU cores the model's pod uses */
    cores: z.number().nullable(),
  }).nullable().optional(),
});

export const FindingsResponse = z.object({ findings: z.array(FindingRecord) });

export const DiffResponse = z.object({
  base: ScanId,
  head: ScanId,
  counts: z.record(DiffClass, z.number().int()),
  items: z.array(FindingRecord.extend({ diff: DiffClass })),
});

export const SiteFinding = z.object({
  fingerprint: Fingerprint,
  sc: WcagSc,
  severity: Severity,
  path: RepoPath,
  line: z.number().int(),
  message: z.string(),
  selectorHint: z.string(),
  url: z.string(),
});
export const SiteFindingsResponse = z.object({
  repo: RepoFullName.nullable(),
  scanId: ScanId.nullable(),
  findings: z.array(SiteFinding),
});
