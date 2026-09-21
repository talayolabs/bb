import { OAUTH_TOKEN_URL } from "./config.ts";
import { errorMessage, type FetchLike } from "./api.ts";

/**
 * The OAuth consumer `bb auth login` uses. Bitbucket Cloud has no device flow or PKCE, so the
 * consumer (key + secret) ships with the CLI, like Sourcetree's. Overridable so a fork or a
 * self-hosted deployment can use its own. Empty until the talayolabs consumer is registered.
 */
export const EMBEDDED_CONSUMER = { key: "", secret: "" };

export interface Consumer {
  key: string;
  secret: string;
}

export function consumerFrom(env: NodeJS.ProcessEnv = process.env): Consumer | null {
  const key = env.BB_OAUTH_CLIENT_ID ?? EMBEDDED_CONSUMER.key;
  const secret = env.BB_OAUTH_CLIENT_SECRET ?? EMBEDDED_CONSUMER.secret;
  return key && secret ? { key, secret } : null;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scopes?: string;
  token_type?: string;
}

export interface RefreshedToken {
  token: string;
  refreshToken: string;
  expiresAt: string;
}

export class OAuthError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`token refresh failed (HTTP ${status})${errorMessage(body) ? `: ${errorMessage(body)}` : ""}`);
    this.name = "OAuthError";
    this.status = status;
  }
}

/** `grant_type=refresh_token` with HTTP Basic client auth; Bitbucket rotates the refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
  consumer: Consumer,
  deps: { fetch?: FetchLike; now?: () => Date; tokenUrl?: string } = {},
): Promise<RefreshedToken> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(deps.tokenUrl ?? OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${consumer.key}:${consumer.secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new OAuthError(res.status, text);
  const json = JSON.parse(text) as TokenResponse;
  return {
    token: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: expiryFrom(json.expires_in, deps.now?.() ?? new Date()),
  };
}

/** Trust `expires_in`; Atlassian's docs disagree with themselves on the nominal lifetime. */
export function expiryFrom(expiresIn: number | undefined, now: Date): string {
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
  return new Date(now.getTime() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function secondsUntil(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return Math.round((t - now.getTime()) / 1000);
}
