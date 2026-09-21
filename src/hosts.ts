import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `hosts.yml` — the one file that holds logins. Layout mirrors `gh`'s so the same tiny YAML
 * subset serves both, and so other writers (e.g. the Sessionboxer Daemon) can render it:
 *
 *   bitbucket.org:
 *       user: jperelli
 *       account_id: "{uuid}"
 *       git_user: x-token-auth
 *       oauth_token: ...
 *       expires_at: 2026-09-21T19:03:00Z
 *       refresh_token: ...          # only when bb obtained the token itself
 *       users:
 *           jperelli:
 *               account_id: "{uuid}"
 *               git_user: x-token-auth
 *               oauth_token: ...
 *               expires_at: ...
 *               refresh_token: ...
 *
 * The top-level scalars duplicate the active user's entry. Only this shape is understood:
 * 4-space indentation, scalar values (bare or double-quoted JSON strings), no lists.
 */
export interface HostUser {
  account: string;
  accountId: string | null;
  gitUser: string;
  token: string;
  expiresAt: string | null;
  refreshToken: string | null;
}

export interface HostEntry {
  active: string | null;
  users: HostUser[];
}

export type HostsFile = Record<string, HostEntry>;

const USER_KEYS = ["account_id", "git_user", "oauth_token", "expires_at", "refresh_token"] as const;

export function readHosts(file: string): HostsFile {
  if (!existsSync(file)) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  return parseHosts(text);
}

export function parseHosts(text: string): HostsFile {
  const out: HostsFile = {};
  let host: string | null = null;
  let hostScalars: Record<string, string> = {};
  let inUsers = false;
  let user: { name: string; fields: Record<string, string> } | null = null;
  const flushUser = () => {
    if (host && user) {
      const entry = out[host]!;
      entry.users.push(toUser(user.name, user.fields));
    }
    user = null;
  };
  const flushHost = () => {
    flushUser();
    if (host) {
      const entry = out[host]!;
      const active = hostScalars["user"] ?? null;
      // A file with only top-level scalars (no `users:`) still describes one login.
      if (active && !entry.users.some((u) => u.account === active) && hostScalars["oauth_token"]) {
        entry.users.unshift(toUser(active, hostScalars));
      }
      entry.active = active && entry.users.some((u) => u.account === active) ? active : (entry.users[0]?.account ?? null);
    }
    host = null;
    hostScalars = {};
    inUsers = false;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      flushHost();
      host = keyOf(body);
      if (host) out[host] = { active: null, users: [] };
      continue;
    }
    if (!host) continue;
    if (indent === 4) {
      flushUser();
      if (body === "users:") {
        inUsers = true;
        continue;
      }
      inUsers = false;
      const kv = scalarOf(body);
      if (kv) hostScalars[kv[0]] = kv[1];
      continue;
    }
    if (indent === 8 && inUsers) {
      flushUser();
      const name = keyOf(body);
      if (name !== null) user = { name, fields: {} };
      continue;
    }
    if (indent === 12 && user) {
      const kv = scalarOf(body);
      if (kv) user.fields[kv[0]] = kv[1];
    }
  }
  flushHost();
  return out;
}

function toUser(name: string, f: Record<string, string>): HostUser {
  return {
    account: name,
    accountId: f["account_id"] ?? null,
    gitUser: f["git_user"] ?? "x-token-auth",
    token: f["oauth_token"] ?? "",
    expiresAt: f["expires_at"] ?? null,
    refreshToken: f["refresh_token"] ?? null,
  };
}

/** `key:` → key (unquoting), else null. */
function keyOf(body: string): string | null {
  if (!body.endsWith(":")) return null;
  return unquote(body.slice(0, -1).trim());
}

/** `key: value` → [key, value] (unquoting), else null. */
function scalarOf(body: string): [string, string] | null {
  const m = /^([^:]+):\s*(.*)$/.exec(body);
  if (!m) return null;
  const value = m[2]!.trim();
  if (value === "") return null;
  return [unquote(m[1]!.trim()), unquote(value)];
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

const BARE = /^[A-Za-z0-9_.\/@+=:-]+$/;
function quote(s: string): string {
  // Bare scalars must not look like other YAML types (`{…}`, `true`, numbers, `null`), hence the strict set.
  if (BARE.test(s) && !/^(true|false|null|yes|no|on|off|~|[0-9.+-]+)$/i.test(s) && !s.includes(": ")) return s;
  return JSON.stringify(s);
}

export function renderHosts(hosts: HostsFile): string {
  let out = "";
  for (const [host, entry] of Object.entries(hosts)) {
    if (entry.users.length === 0) continue;
    const active = entry.users.find((u) => u.account === entry.active) ?? entry.users[0]!;
    out += `${quote(host)}:\n`;
    out += `    user: ${quote(active.account)}\n`;
    out += renderFields(active, 4);
    out += `    users:\n`;
    for (const u of entry.users) {
      out += `        ${quote(u.account)}:\n`;
      out += renderFields(u, 12);
    }
  }
  return out;
}

function renderFields(u: HostUser, indent: number): string {
  const pad = " ".repeat(indent);
  const fields: Record<(typeof USER_KEYS)[number], string | null> = {
    account_id: u.accountId,
    git_user: u.gitUser,
    oauth_token: u.token,
    expires_at: u.expiresAt,
    refresh_token: u.refreshToken,
  };
  let out = "";
  for (const key of USER_KEYS) {
    const v = fields[key];
    if (v !== null && v !== "") out += `${pad}${key}: ${quote(v)}\n`;
  }
  return out;
}

/** Atomic write (tmp + rename), dir 0700, file 0600. Removes the file when nothing is left to store. */
export function writeHosts(file: string, hosts: HostsFile): void {
  const text = renderHosts(hosts);
  if (text === "") {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** True when the file is readable by group/others; callers warn (tokens live in it). */
export function isWorldReadable(file: string): boolean {
  try {
    return process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

export function activeUser(hosts: HostsFile, host: string): HostUser | null {
  const entry = hosts[host];
  if (!entry || entry.users.length === 0) return null;
  return entry.users.find((u) => u.account === entry.active) ?? entry.users[0]!;
}

/** Adds or replaces a login and makes it active. */
export function upsertUser(hosts: HostsFile, host: string, user: HostUser): HostsFile {
  const entry = hosts[host] ?? { active: null, users: [] };
  const users = entry.users.filter((u) => u.account !== user.account);
  return { ...hosts, [host]: { active: user.account, users: [user, ...users] } };
}

/** Replaces a login's fields without changing which one is active (adds it when missing). */
export function updateUser(hosts: HostsFile, host: string, user: HostUser): HostsFile {
  const entry = hosts[host];
  if (!entry || !entry.users.some((u) => u.account === user.account)) return upsertUser(hosts, host, user);
  return { ...hosts, [host]: { ...entry, users: entry.users.map((u) => (u.account === user.account ? user : u)) } };
}

export function removeUser(hosts: HostsFile, host: string, account: string): HostsFile {
  const entry = hosts[host];
  if (!entry) return hosts;
  const users = entry.users.filter((u) => u.account !== account);
  const active = entry.active === account ? (users[0]?.account ?? null) : entry.active;
  const next = { ...hosts };
  if (users.length === 0) delete next[host];
  else next[host] = { active, users };
  return next;
}
