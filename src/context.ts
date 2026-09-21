import { execFile } from "node:child_process";
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
  /** True when a human is at the terminal (stdin is a TTY): prompts and the browser are allowed. */
  interactive: boolean;
  /** Reads one line from the terminal without echoing it. */
  promptSecret: (message: string) => Promise<string>;
  /** Opens a URL in the user's browser; resolves false when no opener is available. */
  openBrowser: (url: string) => Promise<boolean>;
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
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    promptSecret: (message) => promptSecret(message),
    openBrowser: (url) => openBrowser(url, process.env),
  };
}

/** Reads a line from the TTY with echo off (the terminal shows nothing while the token is pasted). */
export function promptSecret(message: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(message);
  return new Promise((resolve, reject) => {
    let buf = "";
    const wasRaw = input.isRaw;
    const done = (err?: Error) => {
      input.removeListener("data", onData);
      if (input.isTTY) input.setRawMode(wasRaw ?? false);
      input.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("interrupted"));
        if (ch === "\u0004") return done();
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

/** `$BROWSER`, else the platform opener. Never throws: the caller prints the URL anyway. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const candidates: Array<[string, string[]]> = [];
  if (env.BROWSER) candidates.push([env.BROWSER, [url]]);
  if (process.platform === "darwin") candidates.push(["open", [url]]);
  else if (process.platform === "win32") candidates.push(["rundll32", ["url.dll,FileProtocolHandler", url]]);
  else candidates.push(["xdg-open", [url]]);
  return new Promise((resolve) => {
    const tryNext = (i: number) => {
      const c = candidates[i];
      if (!c) return resolve(false);
      execFile(c[0], c[1], { env }, (err) => (err ? tryNext(i + 1) : resolve(true)));
    };
    tryNext(0);
  });
}
