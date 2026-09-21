import { flag, has, parseArgs, UsageError, type ParsedArgs } from "../args.ts";
import { BitbucketClient, fetchCurrentUser, ApiError } from "../api.ts";
import { EXPIRY_WARNING_SECONDS, NotLoggedInError, resolveCredential, secondsUntil } from "../auth.ts";
import { GIT_USER_TOKEN_AUTH, baseUrl, hostsFile, normalizeHost, resolveHost } from "../config.ts";
import { handleGitCredential } from "../git-credential.ts";
import { activeUser, isWorldReadable, readHosts, removeUser, upsertUser, writeHosts, type HostUser } from "../hosts.ts";
import { currentRepo } from "../remote.ts";
import type { Context } from "../context.ts";

export const AUTH_HELP = `Authenticate bb with a Bitbucket Data Center instance.

USAGE
  bb auth <command> [flags]

COMMANDS
  login            Log in with an HTTP access token: opens the token page, you paste the token once
  status           Show the logged-in accounts, the active one and token expiry
  token            Print the active access token (for scripts and tools)
  logout           Remove a login (--user <name>, defaults to the active one)
  switch           Make another login active (--user <name>)
  git-credential   Git credential helper; see \`bb auth setup-git\`
  setup-git        Print the git config command that routes the host to bb

FLAGS
  all:     --hostname <host>     Bitbucket host (default: BB_HOST, then the current repository's
                                 remote, then the only logged-in host)
  login:   --with-token          read the token from stdin instead of prompting (scripts, CI)
           --no-browser          print the token page URL instead of opening it
           --user <name>         your Bitbucket username (needed with --skip-verify or when the
                                 instance does not report it)
           --git-user <name>     username git sends with the token (default: your username;
                                 x-token-auth for project/repository tokens)
           --expires-at <iso>    when the token expires, if you gave it an expiry (optional)
           --skip-verify         store the token without calling the API (needs --user)
  status:  --show-token          include the tokens in the output
  token:   --user <name>         token of a specific login instead of the active one

The token needs "Repository: Write" (push, create, review and comment on pull requests — Bitbucket does
not let tokens merge) and "Project: Read". Create it under Profile picture > Manage account > HTTP access tokens.
`;

export async function runAuth(argv: string[], ctx: Context): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "login":
      return login(rest, ctx);
    case "status":
      return status(rest, ctx);
    case "token":
      return token(rest, ctx);
    case "logout":
      return logout(rest, ctx);
    case "switch":
      return switchUser(rest, ctx);
    case "git-credential":
      return gitCredential(rest, ctx);
    case "setup-git":
      return setupGit(rest, ctx);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      ctx.stdout(AUTH_HELP);
      return sub === undefined ? 2 : 0;
    default:
      throw new UsageError(`unknown auth command "${sub}"\n\n${AUTH_HELP}`);
  }
}

function parse(argv: string[], valued: string[], boolean: string[]): ParsedArgs {
  return parseArgs(argv, {
    valued: Object.fromEntries(["hostname", ...valued].map((v) => [v, null])),
    boolean: Object.fromEntries(boolean.map((v) => [v, null])),
  });
}

/** `--hostname` beats BB_HOST beats the git remote beats the only login. */
async function hostFor(args: ParsedArgs, ctx: Context, opts: { allowRemote?: boolean } = {}): Promise<string> {
  const explicit = flag(args, "hostname");
  if (explicit) return normalizeHost(explicit);
  const hosts = readHosts(hostsFile(ctx.env));
  const remote = opts.allowRemote === false ? null : await currentRepo(ctx.env);
  return resolveHost(ctx.env, hosts, remote?.host ?? null);
}

/** The HTTP access tokens page of the logged-in browser user, or of a named user (trailing slash matters). */
export function tokenPageUrl(host: string, username: string | null): string {
  return username
    ? `${baseUrl(host)}/plugins/servlet/access-tokens/users/${encodeURIComponent(username)}/manage`
    : `${baseUrl(host)}/plugins/servlet/access-tokens/`;
}

async function login(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, ["git-user", "expires-at", "user"], ["with-token", "skip-verify", "no-browser"]);
  const explicit = flag(args, "hostname") ?? ctx.env.BB_HOST ?? (await currentRepo(ctx.env))?.host;
  if (!explicit) throw new UsageError("bb auth login: --hostname <host> is required (e.g. --hostname bitbucket.example.com)");
  const host = normalizeHost(explicit);
  const expiresAt = flag(args, "expires-at") ?? null;
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) throw new UsageError(`--expires-at: not a date: ${expiresAt}`);

  const userFlag = flag(args, "user");
  let tokenValue: string;
  if (has(args, "with-token")) {
    tokenValue = ctx.stdin().trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (!tokenValue) throw new UsageError("--with-token: no token on stdin");
  } else {
    if (!ctx.interactive) throw new UsageError("bb auth login: not a terminal; use `bb auth login --hostname <host> --with-token < token.txt`");
    const url = tokenPageUrl(host, userFlag ?? null);
    ctx.stderr(`Create an HTTP access token for bb on ${host}:\n  permissions: Repository → Write (and Project → Read)\n  expiry:      your choice; bb asks you to log in again when it runs out\n`);
    const opened = has(args, "no-browser") ? false : await ctx.openBrowser(url);
    ctx.stderr(opened ? `Opened ${url} in your browser.\n` : `Open ${url} in your browser.\n`);
    tokenValue = (await ctx.promptSecret("Paste the token here: ")).trim();
    if (!tokenValue) throw new UsageError("no token entered");
  }

  let user: HostUser;
  if (has(args, "skip-verify")) {
    if (!userFlag) throw new UsageError("--skip-verify needs --user <name>");
    user = { account: userFlag, accountId: null, gitUser: flag(args, "git-user") ?? userFlag, token: tokenValue, expiresAt };
  } else {
    const client = new BitbucketClient({ host, token: tokenValue, fetch: ctx.fetch, log: ctx.debug });
    let me;
    try {
      me = await fetchCurrentUser(client, userFlag);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        throw new Error(`token rejected by ${host}: ${err.message}\n(use --skip-verify --user <name> to store it anyway)`);
      }
      throw err;
    }
    user = { account: me.name, accountId: String(me.id), gitUser: flag(args, "git-user") ?? me.name, token: tokenValue, expiresAt };
  }
  const file = hostsFile(ctx.env);
  writeHosts(file, upsertUser(readHosts(file), host, user));
  ctx.stderr(`✓ Logged in to ${host} as ${user.account} (git user: ${user.gitUser})\n`);
  return 0;
}

async function status(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, [], ["show-token"]);
  const show = has(args, "show-token");
  const file = hostsFile(ctx.env);
  const hosts = readHosts(file);
  const only = flag(args, "hostname") ?? ctx.env.BB_HOST;
  const lines: string[] = [];
  let exit = 0;
  const mask = (t: string) => (show ? t : t.length > 12 ? `${"*".repeat(12)}${t.slice(-4)}` : "*".repeat(12));

  if (ctx.env.BB_TOKEN) {
    lines.push(only ? normalizeHost(only) : "(any host)");
    lines.push(`  ✓ Using token from BB_TOKEN (git user: ${ctx.env.BB_GIT_USER || GIT_USER_TOKEN_AUTH})`);
    lines.push(`  - Token: ${mask(ctx.env.BB_TOKEN)}`);
  }
  const entries = Object.entries(hosts).filter(([h, e]) => e.users.length > 0 && (!only || normalizeHost(h) === normalizeHost(only)));
  if (entries.length === 0) {
    if (!ctx.env.BB_TOKEN) {
      ctx.stderr(only ? `You are not logged in to ${normalizeHost(only)}. Run \`bb auth login --hostname ${normalizeHost(only)}\`.\n` : "You are not logged in to any Bitbucket host. Run `bb auth login --hostname <host>`.\n");
      return 1;
    }
  }
  const now = ctx.now();
  for (const [host, entry] of entries) {
    lines.push(host);
    for (const u of entry.users) {
      const active = u.account === entry.active;
      const left = secondsUntil(u.expiresAt, now);
      let state = "✓ Logged in";
      if (left !== null && left <= 0) {
        state = "✗ Token expired";
        if (active) exit = 1;
      } else if (left !== null && left < EXPIRY_WARNING_SECONDS) state = "! Token expiring";
      lines.push(`  ${state} to ${host} account ${u.account}${active ? " (active)" : ""}`);
      if (u.accountId) lines.push(`  - Account id: ${u.accountId}`);
      lines.push(`  - Git user: ${u.gitUser}`);
      lines.push(`  - Token: ${mask(u.token)}`);
      if (u.expiresAt) lines.push(`  - Expires: ${u.expiresAt}${left !== null ? ` (${humanDuration(left)})` : ""}`);
    }
  }
  if (entries.length && isWorldReadable(file)) lines.push(`! ${file} is readable by other users; run: chmod 600 ${file}`);
  ctx.stdout(lines.join("\n") + "\n");
  return exit;
}

function humanDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  const unit = abs >= 86400 ? [Math.round(abs / 86400), "d"] : abs >= 3600 ? [Math.round(abs / 3600), "h"] : abs >= 60 ? [Math.round(abs / 60), "m"] : [abs, "s"];
  return seconds < 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}

async function token(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, ["user"], []);
  const host = await hostFor(args, ctx);
  const account = flag(args, "user");
  if (account) {
    const u = readHosts(hostsFile(ctx.env))[host]?.users.find((x) => x.account === account);
    if (!u) throw new NotLoggedInError(host, `no login for ${host} account "${account}"`);
    ctx.stdout(`${u.token}\n`);
    return 0;
  }
  ctx.stdout(`${resolveCredential(host, { env: ctx.env, now: ctx.now }).token}\n`);
  return 0;
}

async function logout(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, ["user"], []);
  const host = await hostFor(args, ctx, { allowRemote: false });
  const file = hostsFile(ctx.env);
  const hosts = readHosts(file);
  const account = flag(args, "user") ?? activeUser(hosts, host)?.account;
  if (!account || !hosts[host]?.users.some((u) => u.account === account)) {
    throw new NotLoggedInError(host, account ? `no login for ${host} account "${account}"` : `not logged in to ${host}`);
  }
  writeHosts(file, removeUser(hosts, host, account));
  ctx.stderr(`✓ Logged out of ${host} account ${account}\n`);
  return 0;
}

async function switchUser(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, ["user"], []);
  const host = await hostFor(args, ctx, { allowRemote: false });
  const file = hostsFile(ctx.env);
  const hosts = readHosts(file);
  const entry = hosts[host];
  if (!entry || entry.users.length === 0) throw new NotLoggedInError(host);
  let account = flag(args, "user");
  if (!account) {
    if (entry.users.length !== 2) throw new UsageError(`--user <name> is required; logins: ${entry.users.map((u) => u.account).join(", ")}`);
    account = entry.users.find((u) => u.account !== entry.active)!.account;
  }
  if (!entry.users.some((u) => u.account === account)) throw new NotLoggedInError(host, `no login for ${host} account "${account}"`);
  writeHosts(file, { ...hosts, [host]: { ...entry, active: account } });
  ctx.stderr(`✓ Switched active account for ${host} to ${account}\n`);
  return 0;
}

async function setupGit(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, [], []);
  const explicit = flag(args, "hostname") ?? ctx.env.BB_HOST;
  const hosts = explicit ? [normalizeHost(explicit)] : Object.keys(readHosts(hostsFile(ctx.env))).map(normalizeHost);
  if (hosts.length === 0) throw new NotLoggedInError(null);
  for (const h of hosts) ctx.stdout(`git config --global credential.https://${h}.helper '!bb auth git-credential'\n`);
  return 0;
}

async function gitCredential(argv: string[], ctx: Context): Promise<number> {
  const op = argv[0] ?? "";
  const stdin = ctx.stdin();
  const result = await handleGitCredential(op, stdin, { env: ctx.env, now: ctx.now });
  if (result.stdout) ctx.stdout(result.stdout);
  if (result.stderr) ctx.stderr(result.stderr + "\n");
  return result.exitCode;
}
