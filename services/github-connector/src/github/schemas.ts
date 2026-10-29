/** Validated views of the GitHub REST API responses we consume. */
import { z } from "zod";

export const GhRepo = z.object({ id: z.number().int(), full_name: z.string(), private: z.boolean(), default_branch: z.string(), homepage: z.string().nullable().optional() });
export const GhCommit = z.object({ sha: z.string() });
export const GhTree = z.object({
  sha: z.string(),
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string(), size: z.number().int().optional() })),
});
export const GhBlob = z.object({ content: z.string(), encoding: z.string(), size: z.number().int() });
export const GhPrFiles = z.array(z.object({ filename: z.string(), status: z.string(), patch: z.string().optional() }));
export const GhPull = z.object({ number: z.number().int(), head: z.object({ sha: z.string(), ref: z.string() }), base: z.object({ sha: z.string(), ref: z.string() }) });
export const GhCheckRun = z.object({ id: z.number().int() });
export const GhInstallationToken = z.object({ token: z.string(), expires_at: z.string() });
export const GhOAuthToken = z.union([z.object({ access_token: z.string() }), z.object({ error: z.string(), error_description: z.string().optional() })]);
export const GhUser = z.object({ login: z.string(), avatar_url: z.string().nullable().optional() });
export const GhUserInstallations = z.object({ installations: z.array(z.object({ id: z.number().int() })) });
export const GhIssueComments = z.array(z.object({ id: z.number().int(), body: z.string().nullable().optional(), user: z.object({ type: z.string() }).nullable() }));
export const GhAny = z.unknown();
