import { homedir } from "node:os";
import { join } from "node:path";

export const HOST = "bitbucket.org";
export const API_BASE = "https://api.bitbucket.org/2.0";
export const OAUTH_AUTHORIZE_URL = "https://bitbucket.org/site/oauth2/authorize";
export const OAUTH_TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token";

/** Static git usernames Bitbucket Cloud accepts with each token type. */
export const GIT_USER_OAUTH = "x-token-auth";
export const GIT_USER_API_TOKEN = "x-bitbucket-api-token-auth";

/** `$BB_CONFIG_DIR`, else `$XDG_CONFIG_HOME/bb`, else `~/.config/bb` (same rule as `gh`). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BB_CONFIG_DIR) return env.BB_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "bb");
  return join(homedir(), ".config", "bb");
}

export function hostsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "hosts.yml");
}

/** Atlassian API tokens (created at id.atlassian.com) start with this prefix; OAuth access tokens do not. */
export function looksLikeApiToken(token: string): boolean {
  return token.startsWith("ATATT");
}

export function defaultGitUser(token: string): string {
  return looksLikeApiToken(token) ? GIT_USER_API_TOKEN : GIT_USER_OAUTH;
}
