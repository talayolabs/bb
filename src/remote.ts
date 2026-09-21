import { execFile } from "node:child_process";
import { normalizeHost } from "./config.ts";

export interface RepoRef {
  host: string;
  /** Project key, or `~user` for personal repositories. */
  project: string;
  slug: string;
}

const HTTPS_RE = /^https?:\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::\d+)?(?:\/[^\s]*?)?\/(?:scm\/([^/\s]+)\/([^/\s]+?)(?:\.git)?|projects\/([^/\s]+)\/repos\/([^/\s]+?))\/?(?:\/(?:browse|pull-requests|commits)(?:[/?#].*)?)?$/i;
// Only the ssh:// form Data Center hands out; scp-like `git@host:a/b.git` is what GitHub/Cloud use.
const SSH_RE = /^ssh:\/\/git@([^/\s:]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** Data Center clone and browse URLs: `https://host/scm/KEY/slug.git`, `ssh://git@host:7999/KEY/slug.git`, `https://host/projects/KEY/repos/slug`. */
export function parseRemote(url: string): RepoRef | null {
  const s = url.trim();
  let m = HTTPS_RE.exec(s);
  if (m) {
    const project = m[2] ?? m[4];
    const slug = m[3] ?? m[5];
    if (!project || !slug) return null;
    return { host: normalizeHost(m[1]!), project, slug };
  }
  m = SSH_RE.exec(s);
  if (m) return { host: normalizeHost(m[1]!), project: m[2]!, slug: m[3]! };
  return null;
}

export interface PrRef extends RepoRef {
  id: number;
}

const PR_URL_RE = /^https?:\/\/([^/\s:]+)(?::\d+)?(?:\/[^\s]*?)?\/projects\/([^/\s]+)\/repos\/([^/\s]+)\/pull-requests\/(\d+)(?:[/?#].*)?$/i;

/** `https://host/projects/KEY/repos/slug/pull-requests/12[/overview|/diff|…]`. */
export function parsePrUrl(url: string): PrRef | null {
  const m = PR_URL_RE.exec(url.trim());
  if (!m) return null;
  return { host: normalizeHost(m[1]!), project: m[2]!, slug: m[3]!, id: Number(m[4]) };
}

/** Runs git and resolves its trimmed stdout, or null when git fails (not a repository, no upstream, …). */
export function git(args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { env, encoding: "utf8" }, (err, stdout) => resolve(err ? null : stdout.replace(/\n$/, "")));
  });
}

/** Name of the checked-out branch, or null when detached or outside a repository. */
export async function currentBranch(env: NodeJS.ProcessEnv): Promise<string | null> {
  const out = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], env);
  return out || null;
}

/** `origin/feature` for the branch's upstream, or null when it has none. */
export function upstreamOf(branch: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], env);
}

/** The Bitbucket repository of the current directory (origin first), or null. */
export async function currentRepo(env: NodeJS.ProcessEnv): Promise<RepoRef | null> {
  const out = (await git(["remote", "-v"], env)) ?? "";
  const lines = out.split("\n").filter((l) => l.includes("(fetch)"));
  lines.sort((a, b) => Number(b.startsWith("origin\t")) - Number(a.startsWith("origin\t")));
  for (const line of lines) {
    const url = line.split(/\s+/)[1];
    const ref = url ? parseRemote(url) : null;
    if (ref) return ref;
  }
  return null;
}
