import { HOST, defaultGitUser, hostsFile } from "./config.ts";
import { activeUser, readHosts, updateUser, writeHosts, type HostUser } from "./hosts.ts";
import { consumerFrom, refreshAccessToken, secondsUntil, type Consumer } from "./oauth.ts";
import type { FetchLike } from "./api.ts";

/** Refresh when the access token has less than this left; also the threshold `auth status` reports as "expiring". */
export const REFRESH_MARGIN_SECONDS = 5 * 60;

export class NotLoggedInError extends Error {
  constructor(message = "not logged in to bitbucket.org; run `bb auth login` or set BB_TOKEN") {
    super(message);
    this.name = "NotLoggedInError";
  }
}

export interface Credential {
  token: string;
  gitUser: string;
  /** Account nickname when known (from hosts.yml); null for `BB_TOKEN`. */
  account: string | null;
  source: "env" | "hosts";
  expiresAt: string | null;
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => Date;
  /** Path override for tests. */
  file?: string;
}

/**
 * Resolution order (same as `gh`): `BB_TOKEN` env wins, then the active user in `hosts.yml`.
 * A hosts.yml login that carries a refresh token is refreshed transparently when it is about
 * to expire, and the rotated tokens are written back.
 */
export async function resolveCredential(deps: ResolveDeps = {}): Promise<Credential> {
  const env = deps.env ?? process.env;
  if (env.BB_TOKEN) {
    return {
      token: env.BB_TOKEN,
      gitUser: env.BB_GIT_USER || defaultGitUser(env.BB_TOKEN),
      account: null,
      source: "env",
      expiresAt: null,
    };
  }
  const file = deps.file ?? hostsFile(env);
  const hosts = readHosts(file);
  let user = activeUser(hosts, HOST);
  if (!user || !user.token) throw new NotLoggedInError();

  const now = deps.now?.() ?? new Date();
  const left = secondsUntil(user.expiresAt, now);
  if (left !== null && left < REFRESH_MARGIN_SECONDS) {
    const consumer = user.refreshToken ? consumerFrom(env) : null;
    if (user.refreshToken && consumer) {
      user = await refreshUser(user, consumer, deps, file);
    } else if (left <= 0) {
      const why = user.refreshToken ? "; no OAuth consumer is configured to refresh it" : "";
      throw new NotLoggedInError(
        `the bitbucket.org token for @${user.account} expired at ${user.expiresAt}${why}; run \`bb auth login\` again`,
      );
    }
  }
  return { token: user.token, gitUser: user.gitUser, account: user.account, source: "hosts", expiresAt: user.expiresAt };
}

async function refreshUser(user: HostUser, consumer: Consumer, deps: ResolveDeps, file: string): Promise<HostUser> {
  const refreshOpts: Parameters<typeof refreshAccessToken>[2] = {};
  if (deps.fetch) refreshOpts.fetch = deps.fetch;
  if (deps.now) refreshOpts.now = deps.now;
  const fresh = await refreshAccessToken(user.refreshToken!, consumer, refreshOpts);
  const next: HostUser = { ...user, token: fresh.token, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt };
  // Re-read before writing: another bb process may have refreshed meanwhile.
  writeHosts(file, updateUser(readHosts(file), HOST, next));
  return next;
}
