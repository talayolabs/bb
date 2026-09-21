import { homedir } from "node:os";
import { join } from "node:path";
import type { HostsFile } from "./hosts.ts";

/**
 * Git username Bitbucket Data Center expects with a project- or repository-level HTTP access
 * token. User tokens go with the user's own username instead.
 */
export const GIT_USER_TOKEN_AUTH = "x-token-auth";

/** `$BB_CONFIG_DIR`, else `$XDG_CONFIG_HOME/bb`, else `~/.config/bb` (same rule as `gh`). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BB_CONFIG_DIR) return env.BB_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "bb");
  return join(homedir(), ".config", "bb");
}

export function hostsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "hosts.yml");
}

/** `https://Host:443/` → `host`; hosts.yml keys and git's `host=` line are compared in this form. */
export function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  h = h.replace(/:443$/, "");
  return h;
}

export function baseUrl(host: string): string {
  return `https://${normalizeHost(host)}`;
}

export class NoHostError extends Error {
  constructor(message = "no Bitbucket host: pass --hostname <host>, set BB_HOST, or run inside a clone of a Bitbucket repository") {
    super(message);
    this.name = "NoHostError";
  }
}

/**
 * Which Bitbucket instance a command talks to: `--hostname` (already copied into `BB_HOST` by the
 * CLI) wins, then the host of the current repository's remote when we are logged in there, then the
 * only host in hosts.yml. There is no default host: Data Center is always self-hosted.
 */
export function resolveHost(env: NodeJS.ProcessEnv, hosts: HostsFile, remoteHost: string | null = null): string {
  if (env.BB_HOST) return normalizeHost(env.BB_HOST);
  if (remoteHost) return normalizeHost(remoteHost);
  const known = Object.keys(hosts).filter((h) => hosts[h]!.users.length > 0);
  if (known.length === 1) return known[0]!;
  if (known.length > 1) throw new NoHostError(`several hosts are logged in (${known.join(", ")}); pass --hostname <host> or set BB_HOST`);
  throw new NoHostError();
}
