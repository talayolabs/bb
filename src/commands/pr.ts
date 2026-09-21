import { readFileSync } from "node:fs";
import { flag, flagAll, has, parseArgs, UsageError, type ParsedArgs } from "../args.ts";
import { BitbucketClient, fetchCurrentUser } from "../api.ts";
import { resolveCredential } from "../auth.ts";
import { baseUrl, hostsFile, normalizeHost, resolveHost } from "../config.ts";
import { activeUser, readHosts } from "../hosts.ts";
import { currentBranch, currentRepo, git, parsePrUrl, upstreamOf, type PrRef, type RepoRef } from "../remote.ts";
import type { Context } from "../context.ts";

export const PR_HELP = `Work with pull requests on Bitbucket Data Center.

USAGE
  bb pr <command> [<number> | <url>] [flags]

COMMANDS
  create           Open a pull request from the current branch
  list             List pull requests of the repository
  view             Show a pull request (default: the one for the current branch)
  checks           Show the build statuses of a pull request's latest commit
  comment          Add a comment (or a reply) to a pull request
  approve          Approve a pull request
  unapprove        Withdraw your approval
  request-changes  Mark a pull request as "needs work"

FLAGS
  all:      --hostname <host>       Bitbucket host (default: BB_HOST, the current remote, or the only login)
        -R, --repo KEY/slug         repository (default: the current directory's Bitbucket remote)
            --json                  print the raw API response instead of text
  create:   -t, --title <text>      title (default: the subject of the last commit)
            -b, --body <text>       description (--body-file <file> or "-" reads it from a file / stdin)
            -B, --base <branch>     target branch (default: the repository's default branch)
            -H, --head <branch>     source branch (default: the current branch, which must be pushed)
            -r, --reviewer <user>   add a reviewer (repeatable)
            -d, --draft             open as a draft
            -w, --web               open the pull request in the browser afterwards
  list:     -s, --state <state>     OPEN (default), MERGED, DECLINED or ALL
            -L, --limit <n>         at most n pull requests (default 30)
            -a, --author <user>     only pull requests by this user
            -B, --base <branch>     only pull requests into this branch
  view:     -c, --comments          include the comment threads
            -w, --web               open in the browser instead of printing
  comment:  -b, --body <text>       comment text (--body-file <file> or "-" reads it from a file / stdin)
            --reply-to <id>         reply to a comment thread instead of commenting on the pull request

Pull requests are addressed by number, by URL (https://host/projects/KEY/repos/slug/pull-requests/12)
or, when omitted, by the current branch. Merging is not possible with an HTTP access token (Bitbucket
requires an interactive user for the merge commit): use \`bb pr view --web\`.

EXAMPLES
  bb pr create --title "Fix login" --body "Closes BOCATO-1" --reviewer alice
  bb pr list --state ALL --limit 10
  bb pr view 12 --comments
  bb pr checks
  bb pr comment 12 --body "Looks good"
  bb pr comment 12 --reply-to 345 --body "Done"
  bb pr approve 12
`;

interface PrApi {
  id: number;
  version: number;
  title: string;
  description?: string;
  state: "OPEN" | "MERGED" | "DECLINED";
  draft?: boolean;
  createdDate?: number;
  updatedDate?: number;
  author?: Participant;
  reviewers?: Participant[];
  participants?: Participant[];
  fromRef: PrRefApi;
  toRef: PrRefApi;
  links?: { self?: Array<{ href: string }> };
}

interface PrRefApi {
  id: string;
  displayId: string;
  latestCommit?: string;
  repository?: { slug: string; project?: { key: string } };
}

interface Participant {
  user: { name: string; displayName?: string; slug?: string };
  role?: "AUTHOR" | "REVIEWER" | "PARTICIPANT";
  approved?: boolean;
  status?: "UNAPPROVED" | "NEEDS_WORK" | "APPROVED";
}

interface CommentApi {
  id: number;
  version?: number;
  text: string;
  author?: { name: string; displayName?: string };
  createdDate?: number;
  severity?: "NORMAL" | "BLOCKER";
  state?: "OPEN" | "RESOLVED";
  threadResolved?: boolean;
  comments?: CommentApi[];
  anchor?: { path?: string; line?: number; lineType?: string };
}

interface ActivityApi {
  id: number;
  action: string;
  createdDate?: number;
  user?: { name: string; displayName?: string };
  comment?: CommentApi;
  commentAnchor?: { path?: string; line?: number };
}

interface BuildStatusApi {
  key: string;
  name?: string;
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "CANCELLED" | "UNKNOWN";
  url?: string;
  description?: string;
}

export async function runPr(argv: string[], ctx: Context): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "create":
      return create(rest, ctx);
    case "list":
      return list(rest, ctx);
    case "view":
      return view(rest, ctx);
    case "checks":
      return checks(rest, ctx);
    case "comment":
      return comment(rest, ctx);
    case "approve":
      return setStatus(rest, ctx, "APPROVED");
    case "unapprove":
      return setStatus(rest, ctx, "UNAPPROVED");
    case "request-changes":
      return setStatus(rest, ctx, "NEEDS_WORK");
    case undefined:
    case "help":
    case "--help":
    case "-h":
      ctx.stdout(PR_HELP);
      return sub === undefined ? 2 : 0;
    default:
      throw new UsageError(`unknown pr command "${sub}"\n\n${PR_HELP}`);
  }
}

const COMMON_VALUED: Record<string, string | null> = { hostname: null, repo: "R" };
const COMMON_BOOLEAN: Record<string, string | null> = { json: null, help: "h" };

function parse(argv: string[], valued: Record<string, string | null>, boolean: Record<string, string | null>): ParsedArgs {
  return parseArgs(argv, { valued: { ...COMMON_VALUED, ...valued }, boolean: { ...COMMON_BOOLEAN, ...boolean } });
}

interface Target {
  repo: RepoRef;
  client: BitbucketClient;
}

/** Repository from --repo / the current remote, host from --hostname / BB_HOST / that remote, and an authenticated client. */
async function target(args: ParsedArgs, ctx: Context, fromUrl: RepoRef | null = null): Promise<Target> {
  const explicitHost = flag(args, "hostname") ?? ctx.env.BB_HOST;
  const repoFlag = flag(args, "repo");
  let repo: RepoRef | null = fromUrl;
  if (!repo && repoFlag) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repoFlag);
    if (!m) throw new UsageError(`--repo: expected KEY/slug, got "${repoFlag}"`);
    if (!explicitHost) {
      const remote = await currentRepo(ctx.env);
      const host = resolveHost(ctx.env, readHosts(hostsFile(ctx.env)), remote?.host ?? null);
      repo = { host, project: m[1]!, slug: m[2]! };
    } else repo = { host: normalizeHost(explicitHost), project: m[1]!, slug: m[2]! };
  }
  if (!repo) repo = await currentRepo(ctx.env);
  if (!repo) throw new UsageError("bb pr: not in a Bitbucket repository; pass --repo KEY/slug (and --hostname <host>)");
  const env = explicitHost ? { ...ctx.env, BB_HOST: explicitHost } : ctx.env;
  const host = resolveHost(env, readHosts(hostsFile(ctx.env)), repo.host);
  const cred = resolveCredential(host, { env: ctx.env, now: ctx.now });
  const client = new BitbucketClient({ host, token: cred.token, fetch: ctx.fetch, log: ctx.debug });
  return { repo: { ...repo, host }, client };
}

function prPath(repo: RepoRef, id?: number): string {
  const base = `projects/${encodeURIComponent(repo.project)}/repos/${encodeURIComponent(repo.slug)}/pull-requests`;
  return id === undefined ? base : `${base}/${id}`;
}

export function prUrl(pr: PrRef): string {
  return `${baseUrl(pr.host)}/projects/${encodeURIComponent(pr.project)}/repos/${encodeURIComponent(pr.slug)}/pull-requests/${pr.id}/overview`;
}

/** `<number>`, `<url>` or nothing (the open pull request from the current branch). */
async function resolvePr(selector: string | undefined, args: ParsedArgs, ctx: Context): Promise<{ t: Target; pr: PrApi }> {
  if (selector !== undefined) {
    const fromUrl = parsePrUrl(selector);
    if (fromUrl) {
      const t = await target(args, ctx, fromUrl);
      return { t, pr: await t.client.request<PrApi>(prPath(t.repo, fromUrl.id)) };
    }
    if (!/^#?\d+$/.test(selector)) throw new UsageError(`bb pr: "${selector}" is neither a pull request number nor a URL`);
    const t = await target(args, ctx);
    return { t, pr: await t.client.request<PrApi>(prPath(t.repo, Number(selector.replace("#", "")))) };
  }
  const t = await target(args, ctx);
  const branch = await currentBranch(ctx.env);
  if (!branch) throw new UsageError("bb pr: no pull request number given and no branch is checked out");
  const found = await t.client.request<{ values: PrApi[] }>(prPath(t.repo), {
    query: { at: `refs/heads/${branch}`, direction: "OUTGOING", state: "OPEN", limit: "2" },
  });
  const pr = found.values[0];
  if (!pr) throw new UsageError(`bb pr: no open pull request for branch "${branch}" in ${t.repo.project}/${t.repo.slug}`);
  return { t, pr };
}

function prRef(t: Target, pr: PrApi): PrRef {
  return { ...t.repo, id: pr.id };
}

function bodyFrom(args: ParsedArgs, ctx: Context, what: string): string | undefined {
  const text = flag(args, "body");
  const file = flag(args, "body-file");
  if (text !== undefined && file !== undefined) throw new UsageError(`${what}: --body and --body-file are mutually exclusive`);
  if (file !== undefined) return file === "-" ? ctx.stdin() : readFileSync(file, "utf8");
  return text;
}

async function create(argv: string[], ctx: Context): Promise<number> {
  const args = parse(
    argv,
    { title: "t", body: "b", "body-file": null, base: "B", head: "H", reviewer: "r" },
    { draft: "d", web: "w" },
  );
  if (has(args, "help")) return help(ctx);
  if (args.positional.length) throw new UsageError(`bb pr create: unexpected argument "${args.positional[0]}"`);
  const t = await target(args, ctx);

  let head = flag(args, "head");
  if (!head) {
    head = (await currentBranch(ctx.env)) ?? undefined;
    if (!head) throw new UsageError("bb pr create: no branch is checked out; pass --head <branch>");
    if (!(await upstreamOf(head, ctx.env))) {
      throw new UsageError(`bb pr create: branch "${head}" has not been pushed; run \`git push -u origin ${head}\` first (or pass --head)`);
    }
  }
  let base = flag(args, "base");
  if (!base) {
    const def = await t.client.request<{ displayId?: string } | undefined>(`projects/${encodeURIComponent(t.repo.project)}/repos/${encodeURIComponent(t.repo.slug)}/default-branch`);
    base = def?.displayId;
    if (!base) throw new UsageError("bb pr create: the repository has no default branch; pass --base <branch>");
  }
  if (base === head) throw new UsageError(`bb pr create: source and target are both "${head}"; pass --base or --head`);

  let title = flag(args, "title");
  let body = bodyFrom(args, ctx, "bb pr create");
  if (!title) {
    const msg = await git(["log", "-1", "--format=%s%n%n%b", head], ctx.env);
    if (!msg) throw new UsageError("bb pr create: --title is required (could not read the last commit)");
    const [subject, ...restLines] = msg.split("\n");
    title = subject!.trim();
    if (body === undefined) body = restLines.join("\n").trim() || undefined;
  }

  const created = await t.client.request<PrApi>(prPath(t.repo), {
    method: "POST",
    body: {
      title,
      description: body ?? "",
      draft: has(args, "draft") || undefined,
      fromRef: { id: `refs/heads/${head}`, repository: refRepository(t.repo) },
      toRef: { id: `refs/heads/${base}`, repository: refRepository(t.repo) },
      reviewers: flagAll(args, "reviewer").map((name) => ({ user: { name } })),
    },
  });
  const url = prUrl(prRef(t, created));
  if (has(args, "json")) ctx.stdout(JSON.stringify(created, null, 2) + "\n");
  else ctx.stdout(`${url}\n`);
  if (has(args, "web")) await ctx.openBrowser(url);
  return 0;
}

function refRepository(repo: RepoRef): { slug: string; project: { key: string } } {
  return { slug: repo.slug, project: { key: repo.project } };
}

async function list(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, { state: "s", limit: "L", author: "a", base: "B" }, {});
  if (has(args, "help")) return help(ctx);
  if (args.positional.length) throw new UsageError(`bb pr list: unexpected argument "${args.positional[0]}"`);
  const t = await target(args, ctx);
  const state = (flag(args, "state") ?? "OPEN").toUpperCase();
  if (!["OPEN", "MERGED", "DECLINED", "ALL"].includes(state)) throw new UsageError(`bb pr list: --state must be OPEN, MERGED, DECLINED or ALL`);
  const limit = Number(flag(args, "limit") ?? "30");
  if (!Number.isInteger(limit) || limit <= 0) throw new UsageError("bb pr list: --limit must be a positive integer");
  const query: Record<string, string> = { state, limit: String(Math.min(limit, 100)) };
  const base = flag(args, "base");
  if (base) query.at = `refs/heads/${base}`;
  const author = flag(args, "author");
  if (author) {
    query["username.1"] = author;
    query["role.1"] = "AUTHOR";
  }
  const prs: PrApi[] = [];
  for await (const pr of t.client.paginate<PrApi>(prPath(t.repo), { query })) {
    prs.push(pr);
    if (prs.length >= limit) break;
  }
  if (has(args, "json")) {
    ctx.stdout(JSON.stringify(prs, null, 2) + "\n");
    return 0;
  }
  if (prs.length === 0) {
    ctx.stderr(`no ${state === "ALL" ? "" : state.toLowerCase() + " "}pull requests in ${t.repo.project}/${t.repo.slug}\n`);
    return 0;
  }
  const rows = prs.map((pr) => [`#${pr.id}`, pr.title, pr.author?.user.name ?? "", `${pr.fromRef.displayId} → ${pr.toRef.displayId}`, stateLabel(pr)]);
  ctx.stdout(table(rows));
  return 0;
}

function stateLabel(pr: PrApi): string {
  return pr.state === "OPEN" && pr.draft ? "DRAFT" : pr.state;
}

async function view(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, {}, { comments: "c", web: "w" });
  if (has(args, "help")) return help(ctx);
  if (args.positional.length > 1) throw new UsageError(`bb pr view: unexpected argument "${args.positional[1]}"`);
  const { t, pr } = await resolvePr(args.positional[0], args, ctx);
  const url = prUrl(prRef(t, pr));
  if (has(args, "web")) {
    if (!(await ctx.openBrowser(url))) ctx.stdout(`${url}\n`);
    return 0;
  }
  const threads = has(args, "comments") ? await fetchThreads(t, pr) : null;
  if (has(args, "json")) {
    ctx.stdout(JSON.stringify(threads ? { ...pr, threads } : pr, null, 2) + "\n");
    return 0;
  }
  const lines = [
    `${pr.title} #${pr.id}`,
    `${stateLabel(pr)} · ${pr.author?.user.displayName ?? pr.author?.user.name ?? "?"} wants to merge ${pr.fromRef.displayId} into ${pr.toRef.displayId}`,
  ];
  const reviewers = pr.reviewers ?? [];
  if (reviewers.length) lines.push(`Reviewers: ${reviewers.map((r) => `${r.user.name} (${(r.status ?? "UNAPPROVED").toLowerCase().replace("_", " ")})`).join(", ")}`);
  lines.push("", pr.description?.trim() || "(no description)", "", url);
  if (threads) {
    lines.push("", threads.length ? `${threads.length} comment thread${threads.length === 1 ? "" : "s"}:` : "no comments");
    for (const thread of threads) lines.push("", ...renderThread(thread, 0));
  }
  ctx.stdout(lines.join("\n") + "\n");
  return 0;
}

/** Top-level comments (with nested replies) in chronological order, from the activity stream. */
async function fetchThreads(t: Target, pr: PrApi): Promise<CommentApi[]> {
  const activities = await t.client.all<ActivityApi>(`${prPath(t.repo, pr.id)}/activities`, { query: { limit: "100" } });
  return activities
    .filter((a) => a.action === "COMMENTED" && a.comment)
    .map((a) => {
      const anchor = a.comment!.anchor ?? a.commentAnchor;
      return anchor ? { ...a.comment!, anchor } : a.comment!;
    })
    .sort((a, b) => (a.createdDate ?? 0) - (b.createdDate ?? 0));
}

function renderThread(c: CommentApi, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const who = c.author?.displayName ?? c.author?.name ?? "?";
  const tags = [c.severity === "BLOCKER" ? (c.state === "RESOLVED" ? "task ✓" : "task") : null, c.threadResolved ? "resolved" : null, c.anchor?.path ? `${c.anchor.path}${c.anchor.line ? `:${c.anchor.line}` : ""}` : null].filter(Boolean);
  const out = [`${pad}[${c.id}] ${who}${c.createdDate ? ` · ${new Date(c.createdDate).toISOString().slice(0, 16).replace("T", " ")}` : ""}${tags.length ? ` · ${tags.join(", ")}` : ""}`];
  for (const line of c.text.split("\n")) out.push(`${pad}  ${line}`);
  for (const reply of c.comments ?? []) out.push(...renderThread(reply, depth + 1));
  return out;
}

async function checks(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, {}, {});
  if (has(args, "help")) return help(ctx);
  if (args.positional.length > 1) throw new UsageError(`bb pr checks: unexpected argument "${args.positional[1]}"`);
  const { t, pr } = await resolvePr(args.positional[0], args, ctx);
  const sha = pr.fromRef.latestCommit;
  if (!sha) throw new Error(`pull request #${pr.id} has no source commit`);
  const builds = await t.client.all<BuildStatusApi>(`rest/build-status/latest/commits/${sha}`);
  if (has(args, "json")) {
    ctx.stdout(JSON.stringify(builds, null, 2) + "\n");
  } else if (builds.length === 0) {
    ctx.stdout(`no build statuses for ${sha.slice(0, 11)} (#${pr.id})\n`);
  } else {
    const mark: Record<BuildStatusApi["state"], string> = { SUCCESSFUL: "✓", FAILED: "✗", INPROGRESS: "*", CANCELLED: "-", UNKNOWN: "?" };
    ctx.stdout(table(builds.map((b) => [mark[b.state] ?? "?", b.name ?? b.key, b.state, b.url ?? ""])));
  }
  return builds.some((b) => b.state === "FAILED") ? 1 : 0;
}

async function comment(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, { body: "b", "body-file": null, "reply-to": null }, {});
  if (has(args, "help")) return help(ctx);
  if (args.positional.length > 1) throw new UsageError(`bb pr comment: unexpected argument "${args.positional[1]}"`);
  const text = bodyFrom(args, ctx, "bb pr comment")?.trim();
  if (!text) throw new UsageError("bb pr comment: --body <text> or --body-file <file> is required");
  const replyTo = flag(args, "reply-to");
  if (replyTo !== undefined && !/^\d+$/.test(replyTo)) throw new UsageError("bb pr comment: --reply-to takes a comment id");
  const { t, pr } = await resolvePr(args.positional[0], args, ctx);
  const created = await t.client.request<CommentApi>(`${prPath(t.repo, pr.id)}/comments`, {
    method: "POST",
    body: replyTo !== undefined ? { text, parent: { id: Number(replyTo) } } : { text },
  });
  if (has(args, "json")) ctx.stdout(JSON.stringify(created, null, 2) + "\n");
  else ctx.stdout(`${prUrl(prRef(t, pr))}?commentId=${created.id}\n`);
  return 0;
}

async function setStatus(argv: string[], ctx: Context, status: "APPROVED" | "UNAPPROVED" | "NEEDS_WORK"): Promise<number> {
  const args = parse(argv, {}, {});
  if (has(args, "help")) return help(ctx);
  if (args.positional.length > 1) throw new UsageError(`bb pr: unexpected argument "${args.positional[1]}"`);
  const { t, pr } = await resolvePr(args.positional[0], args, ctx);
  const me = await currentUserSlug(t, ctx);
  const result = await t.client.request<Participant>(`${prPath(t.repo, pr.id)}/participants/${encodeURIComponent(me)}`, {
    method: "PUT",
    body: { status },
  });
  if (has(args, "json")) ctx.stdout(JSON.stringify(result, null, 2) + "\n");
  else {
    const verb = status === "APPROVED" ? "Approved" : status === "NEEDS_WORK" ? "Requested changes on" : "Removed approval from";
    ctx.stdout(`✓ ${verb} pull request #${pr.id} (${pr.title})\n`);
  }
  return 0;
}

/** The stored login's username, or the one the instance reports when only BB_TOKEN is set. */
async function currentUserSlug(t: Target, ctx: Context): Promise<string> {
  if (!ctx.env.BB_TOKEN) {
    const user = activeUser(readHosts(hostsFile(ctx.env)), t.client.host);
    if (user?.account) return user.account;
  }
  return (await fetchCurrentUser(t.client)).slug;
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n") + "\n";
}

function help(ctx: Context): number {
  ctx.stdout(PR_HELP);
  return 0;
}
