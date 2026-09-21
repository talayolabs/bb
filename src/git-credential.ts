import { hostsFile, normalizeHost } from "./config.ts";
import { NotLoggedInError, resolveCredential, type ResolveDeps } from "./auth.ts";
import { readHosts } from "./hosts.ts";

/**
 * Git credential helper (see git-credential(7)). Configure with
 *   git config --global credential.https://<host>.helper '!bb auth git-credential'
 * `get` answers for hosts bb is logged in to (or `BB_HOST` when `BB_TOKEN` is set); `store`/`erase`
 * are accepted and ignored so git never persists the token through another helper in the chain.
 */
export type GitCredentialOp = "get" | "store" | "erase";

export function parseGitCredentialInput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).replace(/\r$/, "");
  }
  return out;
}

export interface GitCredentialResult {
  stdout: string;
  exitCode: number;
  stderr?: string;
}

export async function handleGitCredential(op: string, stdin: string, deps: ResolveDeps = {}): Promise<GitCredentialResult> {
  if (op !== "get") {
    if (op === "store" || op === "erase") return { stdout: "", exitCode: 0 };
    return { stdout: "", exitCode: 1, stderr: `bb auth git-credential: unknown operation "${op}"` };
  }
  const input = parseGitCredentialInput(stdin);
  if (input["protocol"] !== "https" || !input["host"]) return { stdout: "", exitCode: 0 };
  const host = normalizeHost(input["host"]);
  const env = deps.env ?? process.env;

  const known = env.BB_TOKEN ? (env.BB_HOST ? [normalizeHost(env.BB_HOST)] : []) : Object.keys(readHosts(deps.file ?? hostsFile(env))).map(normalizeHost);
  if (!known.includes(host)) return { stdout: "", exitCode: 0 };
  try {
    const cred = resolveCredential(host, deps);
    // If git already knows a username from the remote URL, only answer when it is ours;
    // a different explicit user means the remote is for another account.
    const wanted = input["username"];
    if (wanted && wanted !== cred.gitUser && wanted !== cred.account) return { stdout: "", exitCode: 0 };
    return { stdout: `username=${cred.gitUser}\npassword=${cred.token}\n`, exitCode: 0 };
  } catch (err) {
    if (err instanceof NotLoggedInError) return { stdout: "", exitCode: 0, stderr: `bb: ${err.message}` };
    throw err;
  }
}
