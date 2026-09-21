import { HOST } from "./config.ts";
import { NotLoggedInError, resolveCredential, type ResolveDeps } from "./auth.ts";

/**
 * Git credential helper (see git-credential(7)). Configure with
 *   git config --global credential.https://bitbucket.org.helper '!bb auth git-credential'
 * `get` answers for https://bitbucket.org only; `store`/`erase` are accepted and ignored so git
 * never persists the token through another helper in the chain.
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

export function isOurHost(input: Record<string, string>): boolean {
  const protocol = input["protocol"];
  const host = (input["host"] ?? "").toLowerCase().replace(/:443$/, "");
  return protocol === "https" && host === HOST;
}

export interface GitCredentialResult {
  stdout: string;
  exitCode: number;
  stderr?: string;
}

export async function handleGitCredential(
  op: string,
  stdin: string,
  deps: ResolveDeps = {},
): Promise<GitCredentialResult> {
  if (op !== "get") {
    if (op === "store" || op === "erase") return { stdout: "", exitCode: 0 };
    return { stdout: "", exitCode: 1, stderr: `bb auth git-credential: unknown operation "${op}"` };
  }
  const input = parseGitCredentialInput(stdin);
  if (!isOurHost(input)) return { stdout: "", exitCode: 0 };
  try {
    const cred = await resolveCredential(deps);
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
