/** Minimal, validated views of the GitHub webhook payloads we act on. */
import { z } from "zod";

const Repo = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean().optional(),
  default_branch: z.string().optional(),
  homepage: z.string().nullable().optional(),
});
const Installation = z.object({ id: z.number().int() });

export const InstallationEvent = z.object({
  action: z.string(),
  installation: Installation.extend({ account: z.object({ login: z.string() }) }),
  repositories: z.array(z.object({ id: z.number().int(), full_name: z.string(), private: z.boolean().optional() })).optional(),
});
export const InstallationReposEvent = z.object({
  action: z.string(),
  installation: Installation,
  repositories_added: z.array(z.object({ id: z.number().int(), full_name: z.string() })).default([]),
  repositories_removed: z.array(z.object({ id: z.number().int(), full_name: z.string() })).default([]),
});
export const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number().int(),
  installation: Installation,
  repository: Repo,
  pull_request: z.object({
    head: z.object({ sha: z.string(), ref: z.string() }),
    base: z.object({ sha: z.string(), ref: z.string() }),
  }),
});
export const PushEvent = z.object({
  ref: z.string(),
  after: z.string(),
  installation: Installation,
  repository: Repo,
});
export const IssueCommentEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository: Repo,
  issue: z.object({ number: z.number().int(), pull_request: z.unknown().optional() }),
  comment: z.object({ body: z.string(), user: z.object({ login: z.string(), type: z.string() }) }),
});
