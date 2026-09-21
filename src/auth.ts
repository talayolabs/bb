import { GIT_USER_TOKEN_AUTH, hostsFile, normalizeHost } from "./config.ts";
import { activeUser, readHosts } from "./hosts.ts";

/** `auth status` reports a token as "expiring" when it has less than this left. */
export const EXPIRY_WARNING_SECONDS = 7 * 24 * 3600;

export class NotLoggedInError extends Error {
  constructor(host: string | null, message?: string) {
    super(message ?? `not logged in to ${host ?? "any Bitbucket host"}; run \`bb auth login --hostname ${host ?? "<host>"}\` or set BB_TOKEN`);
    this.name = "NotLoggedInError";
  }
}

export interface Credential {
  host: string;
  token: string;
  /** Username git sends with the token (the user's own name, or x-token-auth for project/repo tokens). */
  gitUser: string;
  /** Account name when known (from hosts.yml); null for `BB_TOKEN`. */
  account: string | null;
  source: "env" | "hosts";
  expiresAt: string | null;
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Path override for tests. */
  file?: string;
}

/**
 * Resolution order (same as `gh`): `BB_TOKEN` env wins, then the active user for `host` in
 * `hosts.yml`. An expired token is reported, not served.
 */
export function resolveCredential(host: string, deps: ResolveDeps = {}): Credential {
  const env = deps.env ?? process.env;
  const h = normalizeHost(host);
  if (env.BB_TOKEN) {
    return { host: h, token: env.BB_TOKEN, gitUser: env.BB_GIT_USER || GIT_USER_TOKEN_AUTH, account: null, source: "env", expiresAt: null };
  }
  const user = activeUser(readHosts(deps.file ?? hostsFile(env)), h);
  if (!user || !user.token) throw new NotLoggedInError(h);
  const left = secondsUntil(user.expiresAt, deps.now?.() ?? new Date());
  if (left !== null && left <= 0) {
    throw new NotLoggedInError(h, `the ${h} token for ${user.account} expired at ${user.expiresAt}; create a new one with \`bb auth login --hostname ${h}\``);
  }
  return { host: h, token: user.token, gitUser: user.gitUser, account: user.account, source: "hosts", expiresAt: user.expiresAt };
}

/** Seconds from `now` until `expiresAt`; null when there is no expiry or it is unparseable. */
export function secondsUntil(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / 1000);
}
