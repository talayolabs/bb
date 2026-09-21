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
}

export function testContext(opts: { fetch?: typeof fetch; stdin?: string; env?: Record<string, string>; now?: Date } = {}): TestContext {
  const configDir = mkdtempSync(join(tmpdir(), "bb-test-"));
  const out: string[] = [];
  const err: string[] = [];
  const debugLines: string[] = [];
  return {
    env: { BB_CONFIG_DIR: configDir, ...opts.env },
    fetch: opts.fetch ?? (() => Promise.reject(new Error("unexpected network call"))),
    now: () => opts.now ?? new Date("2026-09-21T12:00:00Z"),
    stdin: () => opts.stdin ?? "",
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    debug: (l) => debugLines.push(l),
    out,
    err,
    debugLines,
    configDir,
  };
}
