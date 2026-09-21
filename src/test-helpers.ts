import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "./context.ts";

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export type Route = (req: FakeRequest) => Response | Promise<Response>;

/** In-memory `fetch`: records requests and answers from a route function. */
export function fakeFetch(route: Route): { fetch: typeof fetch; requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const body = typeof init?.body === "string" ? init.body : null;
    const req = { method: (init?.method ?? "GET").toUpperCase(), url, headers, body };
    requests.push(req);
    return route(req);
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface TestContext extends Context {
  out: string[];
  err: string[];
  debugLines: string[];
  configDir: string;
  /** URLs `openBrowser` was asked to open. */
  opened: string[];
  /** Prompts shown by `promptSecret`. */
  prompts: string[];
}

export interface TestContextOptions {
  fetch?: typeof fetch;
  stdin?: string;
  env?: Record<string, string>;
  now?: Date;
  interactive?: boolean;
  /** Answer to `promptSecret`. */
  secret?: string;
  /** Whether `openBrowser` reports success (default true). */
  browserOpens?: boolean;
}

export function testContext(opts: TestContextOptions = {}): TestContext {
  const configDir = mkdtempSync(join(tmpdir(), "bb-test-"));
  const out: string[] = [];
  const err: string[] = [];
  const debugLines: string[] = [];
  const opened: string[] = [];
  const prompts: string[] = [];
  return {
    // GIT_DIR points `git remote -v` at nowhere so the test's own checkout never leaks in.
    env: { BB_CONFIG_DIR: configDir, GIT_DIR: join(configDir, "no-git"), ...opts.env },
    fetch: opts.fetch ?? (() => Promise.reject(new Error("unexpected network call"))),
    now: () => opts.now ?? new Date("2026-09-21T12:00:00Z"),
    stdin: () => opts.stdin ?? "",
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    debug: (l) => debugLines.push(l),
    interactive: opts.interactive ?? false,
    promptSecret: async (message) => {
      prompts.push(message);
      return opts.secret ?? "";
    },
    openBrowser: async (url) => {
      opened.push(url);
      return opts.browserOpens ?? true;
    },
    out,
    err,
    debugLines,
    configDir,
    opened,
    prompts,
  };
}
