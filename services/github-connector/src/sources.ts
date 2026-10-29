/**
 * Where repository snapshots come from:
 *  - github-app: repos where the App is installed (installation token, works for private repos)
 *  - public:     public repos without the App (tree via REST, file content via raw CDN)
 *  - fixture:    a bundled demo repository (works offline / without any GitHub credentials)
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Selectable } from "kysely";
import type { DB } from "@deepscan/platform";
import { env } from "./env.js";
import { gh, installationToken } from "./github/client.js";
import { GhBlob, GhCommit, GhPrFiles, GhTree } from "./github/schemas.js";

export interface TreeEntry { path: string; sha: string; size: number }
export interface ChangedFile { path: string; patch?: string }

export interface RepoSource {
  resolve(ref: string): Promise<string>;
  tree(sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  content(e: { path: string; sha: string }, headSha: string): Promise<string>;
  prFiles(prNumber: number): Promise<ChangedFile[]>;
}

type RepoRow = Selectable<DB["repos"]>;
export const FIXTURE_REPO = "deepscan-demo/nordic-outdoor-gear";

class GithubSource implements RepoSource {
  constructor(private full: string, private token: () => Promise<string | null>) {}
  async resolve(ref: string) {
    return (await gh({ path: `/repos/${this.full}/commits/${encodeURIComponent(ref)}`, schema: GhCommit, token: await this.token() })).sha;
  }
  async tree(sha: string) {
    const t = await gh({ path: `/repos/${this.full}/git/trees/${sha}?recursive=1`, schema: GhTree, token: await this.token() });
    return { truncated: t.truncated, entries: t.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })) };
  }
  async content(e: { path: string; sha: string }, headSha: string) {
    const token = await this.token();
    if (token) {
      const b = await gh({ path: `/repos/${this.full}/git/blobs/${e.sha}`, schema: GhBlob, token });
      return Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    }
    // public repo without credentials: raw CDN does not consume REST rate limit
    const url = `${env.GITHUB_RAW_URL}/${this.full}/${headSha}/${e.path.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`raw fetch ${res.status} for ${e.path}`);
    return res.text();
  }
  async prFiles(n: number) {
    const out: ChangedFile[] = [];
    for (let page = 1; page <= 10; page++) {
      const files = await gh({ path: `/repos/${this.full}/pulls/${n}/files?per_page=100&page=${page}`, schema: GhPrFiles, token: await this.token() });
      out.push(...files.filter((f) => f.status !== "removed").map((f) => ({ path: f.filename, patch: f.patch })));
      if (files.length < 100) break;
    }
    return out;
  }
}

const gitBlobSha = (buf: Buffer) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

class FixtureSource implements RepoSource {
  constructor(private dir: string) {}
  private async walk(): Promise<(TreeEntry & { abs: string })[]> {
    const out: (TreeEntry & { abs: string })[] = [];
    const rec = async (d: string) => {
      for (const ent of await readdir(d, { withFileTypes: true })) {
        const abs = join(d, ent.name);
        if (ent.isDirectory()) await rec(abs);
        else if (ent.isFile()) {
          const buf = await readFile(abs);
          out.push({ abs, path: relative(this.dir, abs).split("\\").join("/"), sha: gitBlobSha(buf), size: (await stat(abs)).size });
        }
      }
    };
    await rec(this.dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  async resolve() {
    const h = createHash("sha1");
    for (const e of await this.walk()) h.update(`${e.path}:${e.sha}\n`);
    return h.digest("hex");
  }
  async tree() {
    return { truncated: false, entries: (await this.walk()).map(({ path, sha, size }) => ({ path, sha, size })) };
  }
  async content(e: { path: string }) {
    return readFile(join(this.dir, e.path), "utf8");
  }
  async prFiles(): Promise<ChangedFile[]> {
    throw new Error("fixture repositories have no pull requests");
  }
}

export function sourceFor(repo: RepoRow): RepoSource {
  if (repo.source === "fixture") {
    if (!env.FIXTURES_DIR) throw new Error("FIXTURES_DIR not configured");
    return new FixtureSource(join(env.FIXTURES_DIR, "demo-site"));
  }
  if (repo.installation_id) {
    const id = repo.installation_id;
    return new GithubSource(repo.full_name, () => installationToken(id));
  }
  return new GithubSource(repo.full_name, async () => env.GITHUB_TOKEN ?? null);
}

/** Which files the agent analyses. Everything else is still recorded (for read_file / list_related). */
const SCANNABLE = /\.(html?|jsx|tsx|vue|svelte|css|scss)$/i;
const IGNORED = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.nuxt|\.git|storybook-static)\//i;
export function isScannable(path: string, size: number): boolean {
  return SCANNABLE.test(path) && !IGNORED.test(path) && !/\.min\.(css|js)$/i.test(path) && !/\.(test|spec|stories)\.[jt]sx?$/i.test(path) && size <= env.MAX_FILE_BYTES;
}
