import { readFileSync } from "node:fs";
import type { FetchLike } from "./api.ts";

/** Everything a command touches from the outside world, so tests can run commands in-process. */
export interface Context {
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  now: () => Date;
  stdin: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Verbose request log (`--verbose` / `BB_DEBUG=1`); never receives header values. */
  debug: (line: string) => void;
}

export function processContext(verbose: boolean): Context {
  return {
    env: process.env,
    fetch,
    now: () => new Date(),
    stdin: () => readFileSync(0, "utf8"),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    debug: verbose || process.env.BB_DEBUG ? (l) => process.stderr.write(`[bb] ${l}\n`) : () => {},
  };
}
