/** Branded identifiers: a plain string cannot be passed where a RepoPath is expected. */
import { z } from "zod";

export const RepoPath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0"), "must be a relative POSIX path")
  .refine((p) => !p.split("/").some((s) => s === ".." || s === "." || s === ""), "must not contain '.', '..' or empty segments")
  .brand<"RepoPath">();
export type RepoPath = z.infer<typeof RepoPath>;

export const Fingerprint = z.string().regex(/^[a-f0-9]{16}$/).brand<"Fingerprint">();
export type Fingerprint = z.infer<typeof Fingerprint>;

export const ScanId = z.uuid().brand<"ScanId">();
export type ScanId = z.infer<typeof ScanId>;

export const RepoId = z.uuid().brand<"RepoId">();
export type RepoId = z.infer<typeof RepoId>;

export const InstallationId = z.number().int().positive().brand<"InstallationId">();
export type InstallationId = z.infer<typeof InstallationId>;

export const GitSha = z.string().regex(/^[a-f0-9]{40}$/).brand<"GitSha">();
export type GitSha = z.infer<typeof GitSha>;

/** "owner/name" — validated so it can never smuggle a host or path. */
export const RepoFullName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/)
  .refine((s) => !s.endsWith(".git") && !s.split("/")[1]!.startsWith("."), "invalid repo name")
  .brand<"RepoFullName">();
export type RepoFullName = z.infer<typeof RepoFullName>;

/** Accepts only https://github.com/{owner}/{repo}[/] (SSRF guard). */
export function parseGithubUrl(url: string): RepoFullName | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return null;
  const r = RepoFullName.safeParse(`${m[1]}/${m[2]}`);
  return r.success ? r.data : null;
}
