import { flag, has, parseArgs, UsageError, type ParsedArgs } from "../args.ts";
import { BitbucketClient, fetchCurrentUser, ApiError } from "../api.ts";
import { REFRESH_MARGIN_SECONDS, NotLoggedInError, resolveCredential } from "../auth.ts";
import { HOST, defaultGitUser, hostsFile } from "../config.ts";
import { handleGitCredential } from "../git-credential.ts";
import { activeUser, isWorldReadable, readHosts, removeUser, upsertUser, writeHosts, type HostUser } from "../hosts.ts";
import { secondsUntil } from "../oauth.ts";
import type { Context } from "../context.ts";

export const AUTH_HELP = `Authenticate bb with bitbucket.org.

USAGE
  bb auth <command> [flags]

COMMANDS
  login            Log in with an access token from stdin (--with-token); browser login comes later
  status           Show the logged-in accounts, the active one and token expiry
  token            Print the active access token (for scripts and tools)
  logout           Remove a login (--user <name>, defaults to the active one)
  switch           Make another login active (--user <name>)
  git-credential   Git credential helper; see \`bb auth setup-git\`
  setup-git        Print the git config command that routes bitbucket.org to bb

FLAGS
  login:   --with-token          read the token from stdin (required for now)
           --git-user <name>     git username the token needs (default: derived from the token:
                                 x-bitbucket-api-token-auth for Atlassian API tokens, x-token-auth otherwise)
           --expires-at <iso>    when the token expires (OAuth access tokens; optional)
           --skip-verify         do not call /2.0/user (stores the token under --user <name>)
           --user <name>         account name to store the token under (with --skip-verify)
  status:  --show-token          include the tokens in the output
  token:   --user <name>         token of a specific login instead of the active one
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
      ctx.stdout(`git config --global credential.https://${HOST}.helper '!bb auth git-credential'\n`);
      return 0;
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
    valued: Object.fromEntries(valued.map((v) => [v, null])),
    boolean: Object.fromEntries(boolean.map((v) => [v, null])),
  });
}

async function login(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, ["git-user", "expires-at", "user"], ["with-token", "skip-verify", "web"]);
  if (has(args, "web") || !has(args, "with-token")) {
    throw new UsageError(
      "browser login is not available yet; use `bb auth login --with-token < token.txt` with an Atlassian API token " +
        "(https://id.atlassian.com/manage-profile/security/api-tokens, scopes: read:user:bitbucket, " +
        "read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket)",
    );
  }
  const raw = ctx.stdin().trim();
  const tokenValue = raw.split(/\r?\n/)[0]?.trim() ?? "";
  if (!tokenValue) throw new UsageError("--with-token: no token on stdin");
  const gitUser = flag(args, "git-user") ?? defaultGitUser(tokenValue);
  const expiresAt = flag(args, "expires-at") ?? null;
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) throw new UsageError(`--expires-at: not a date: ${expiresAt}`);

  let user: HostUser;
  if (has(args, "skip-verify")) {
    const account = flag(args, "user");
    if (!account) throw new UsageError("--skip-verify needs --user <name>");
    user = { account, accountId: null, gitUser, token: tokenValue, expiresAt, refreshToken: null };
  } else {
    const client = new BitbucketClient({ token: tokenValue, fetch: ctx.fetch, log: ctx.debug });
    let me;
    try {
      me = await fetchCurrentUser(client);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        throw new Error(`token rejected by ${HOST}: ${err.message}\n(an API token needs the read:user:bitbucket scope for verification; use --skip-verify --user <name> to store it anyway)`);
      }
      throw err;
    }
    user = {
      account: me.nickname || me.display_name,
      accountId: me.account_id ?? me.uuid,
      gitUser,
      token: tokenValue,
      expiresAt,
      refreshToken: null,
    };
  }
  const file = hostsFile(ctx.env);
  writeHosts(file, upsertUser(readHosts(file), HOST, user));
  ctx.stderr(`✓ Logged in to ${HOST} as ${user.account} (git user: ${gitUser})\n`);
  return 0;
}

async function status(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, [], ["show-token"]);
  const show = has(args, "show-token");
  const file = hostsFile(ctx.env);
  const hosts = readHosts(file);
  const entry = hosts[HOST];
  const lines: string[] = [];
  let exit = 0;
  const mask = (t: string) => (show ? t : t.length > 12 ? `${"*".repeat(12)}${t.slice(-4)}` : "*".repeat(12));

  if (ctx.env.BB_TOKEN) {
    lines.push(`${HOST}`);
    lines.push(`  ✓ Using token from BB_TOKEN (git user: ${ctx.env.BB_GIT_USER || defaultGitUser(ctx.env.BB_TOKEN)})`);
    lines.push(`  - Token: ${mask(ctx.env.BB_TOKEN)}`);
  }
  if (!entry || entry.users.length === 0) {
    if (!ctx.env.BB_TOKEN) {
      ctx.stderr(`You are not logged in to ${HOST}. Run \`bb auth login\` to authenticate.\n`);
      return 1;
    }
  } else {
    lines.push(`${HOST}`);
    const now = ctx.now();
    for (const u of entry.users) {
      const active = u.account === entry.active;
      const left = secondsUntil(u.expiresAt, now);
      let state = "✓ Logged in";
      if (left !== null && left <= 0) {
        state = u.refreshToken ? "↻ Token expired (will refresh on use)" : "✗ Token expired";
        if (!u.refreshToken && active) exit = 1;
      } else if (left !== null && left < REFRESH_MARGIN_SECONDS) {
        state = u.refreshToken ? "↻ Token expiring (will refresh on use)" : "! Token expiring";
      }
      lines.push(`  ${state} to ${HOST} account ${u.account}${active ? " (active)" : ""}`);
      if (u.accountId) lines.push(`  - Account id: ${u.accountId}`);
      lines.push(`  - Git user: ${u.gitUser}`);
      lines.push(`  - Token: ${mask(u.token)}`);
      if (u.expiresAt) lines.push(`  - Expires: ${u.expiresAt}${left !== null ? ` (${humanDuration(left)})` : ""}`);
      lines.push(`  - Refresh: ${u.refreshToken ? "available" : "none (log in again when it expires)"}`);
    }
    if (isWorldReadable(file)) lines.push(`  ! ${file} is readable by other users; run: chmod 600 ${file}`);
  }
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
  const account = flag(args, "user");
  if (account) {
    const u = readHosts(hostsFile(ctx.env))[HOST]?.users.find((x) => x.account === account);
    if (!u) throw new NotLoggedInError(`no login for ${HOST} account "${account}"`);
    ctx.stdout(`${u.token}\n`);
    return 0;
  }
  const cred = await resolveCredential({ env: ctx.env, fetch: ctx.fetch, now: ctx.now });
  ctx.stdout(`${cred.token}\n`);
  return 0;
}

async function logout(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, ["user"], []);
  const file = hostsFile(ctx.env);
  const hosts = readHosts(file);
  const account = flag(args, "user") ?? activeUser(hosts, HOST)?.account;
  if (!account || !hosts[HOST]?.users.some((u) => u.account === account)) {
    throw new NotLoggedInError(account ? `no login for ${HOST} account "${account}"` : `not logged in to ${HOST}`);
  }
  writeHosts(file, removeUser(hosts, HOST, account));
  ctx.stderr(`✓ Logged out of ${HOST} account ${account}\n`);
  return 0;
}

async function switchUser(argv: string[], ctx: Context): Promise<number> {
  const args = parse(argv, ["user"], []);
  const file = hostsFile(ctx.env);
  const hosts = readHosts(file);
  const entry = hosts[HOST];
  if (!entry || entry.users.length === 0) throw new NotLoggedInError();
  let account = flag(args, "user");
  if (!account) {
    if (entry.users.length !== 2) throw new UsageError(`--user <name> is required; logins: ${entry.users.map((u) => u.account).join(", ")}`);
    account = entry.users.find((u) => u.account !== entry.active)!.account;
  }
  if (!entry.users.some((u) => u.account === account)) throw new NotLoggedInError(`no login for ${HOST} account "${account}"`);
  writeHosts(file, { ...hosts, [HOST]: { ...entry, active: account } });
  ctx.stderr(`✓ Switched active account for ${HOST} to ${account}\n`);
  return 0;
}

async function gitCredential(argv: string[], ctx: Context): Promise<number> {
  const op = argv[0] ?? "";
  const stdin = ctx.stdin();
  const result = await handleGitCredential(op, stdin, { env: ctx.env, fetch: ctx.fetch, now: ctx.now });
  if (result.stdout) ctx.stdout(result.stdout);
  if (result.stderr) ctx.stderr(result.stderr + "\n");
  return result.exitCode;
}
