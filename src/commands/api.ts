import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { flag, flagAll, has, parseArgs, UsageError } from "../args.ts";
import { BitbucketClient, type RequestOptions } from "../api.ts";
import { resolveCredential } from "../auth.ts";
import type { Context } from "../context.ts";

export const API_HELP = `Make an authenticated request to the Bitbucket Cloud REST API.

USAGE
  bb api <path> [flags]

The path is relative to https://api.bitbucket.org/2.0 (e.g. "user", "/repositories/ws/repo/pullrequests")
or a full https://api.bitbucket.org URL such as a "next" page link. Placeholders {workspace} and {repo}
are filled from the current directory's bitbucket.org git remote.

FLAGS
  -X, --method <verb>      HTTP method (default GET, or POST when a body is given)
  -f, --raw-field k=v      add a string field to the JSON body (nested keys: "destination.branch.name=main")
  -F, --field k=v          like -f but typed: true/false/null/numbers are converted, @file reads a file
  -q, --query k=v          add a query-string parameter (repeatable)
      --input <file>       send the file as the request body ("-" for stdin); JSON unless --content-type
      --content-type <ct>  content type for --input
  -H, --header k:v         extra request header
      --paginate           follow "next" links and print all "values" as one JSON array
      --jq <path>          print only this dot path of the response (e.g. ".values[].title", ".display_name")
  -i, --include            print the response status and headers before the body
      --silent             print nothing on success
      --verbose            log requests to stderr (tokens are never printed)

EXAMPLES
  bb api user
  bb api /repositories/{workspace}/{repo}/pullrequests -q state=OPEN --paginate --jq '.[].title'
  bb api /repositories/ws/repo/pullrequests -f title='Fix' -f source.branch.name=fix -f destination.branch.name=main
  bb api /repositories/ws/repo/pullrequests/12/comments/99/resolve -X POST
`;

export async function runApi(argv: string[], ctx: Context): Promise<number> {
  const args = parseArgs(argv, {
    valued: { method: "X", "raw-field": "f", field: "F", query: "q", input: null, "content-type": null, header: "H", jq: null },
    boolean: { paginate: null, include: "i", silent: null, verbose: null, help: "h" },
  });
  if (has(args, "help")) {
    ctx.stdout(API_HELP);
    return 0;
  }
  const path = args.positional[0];
  if (!path) throw new UsageError(`bb api: a path is required\n\n${API_HELP}`);
  if (args.positional.length > 1) throw new UsageError(`bb api: unexpected argument "${args.positional[1]}"`);

  const cred = await resolveCredential({ env: ctx.env, fetch: ctx.fetch, now: ctx.now });
  const client = new BitbucketClient({ token: cred.token, fetch: ctx.fetch, log: ctx.debug });

  const opts: RequestOptions = {};
  const method = flag(args, "method");
  if (method) opts.method = method;
  const query: Record<string, string> = {};
  for (const kv of flagAll(args, "query")) {
    const [k, v] = splitKv(kv, "=");
    query[k] = v;
  }
  if (Object.keys(query).length) opts.query = query;
  const headers: Record<string, string> = {};
  for (const kv of flagAll(args, "header")) {
    const [k, v] = splitKv(kv, ":");
    if (k.toLowerCase() === "authorization") throw new UsageError("bb api: use `bb auth login` or BB_TOKEN instead of an Authorization header");
    headers[k] = v.trim();
  }
  if (Object.keys(headers).length) opts.headers = headers;

  const body = buildBody(flagAll(args, "raw-field"), flagAll(args, "field"), ctx);
  const input = flag(args, "input");
  if (input !== undefined && body !== undefined) throw new UsageError("bb api: --input cannot be combined with -f/-F");
  if (input !== undefined) {
    const text = input === "-" ? ctx.stdin() : readFileSync(input, "utf8");
    const contentType = flag(args, "content-type");
    if (contentType) opts.raw = { body: text, contentType };
    else {
      try {
        opts.body = JSON.parse(text);
      } catch {
        throw new UsageError(`bb api: --input ${input} is not JSON; pass --content-type for other bodies`);
      }
    }
  } else if (body !== undefined) opts.body = body;

  const resolvedPath = await fillPlaceholders(path, ctx);
  const jq = flag(args, "jq");
  const silent = has(args, "silent");

  if (has(args, "paginate")) {
    const values = await client.all<unknown>(resolvedPath, opts);
    if (!silent) ctx.stdout(render(jq ? applyPath(values, jq) : values));
    return 0;
  }

  const res = await client.raw(resolvedPath, opts);
  const text = await res.text();
  if (has(args, "include")) {
    ctx.stdout(`HTTP ${res.status} ${res.statusText}\n`);
    for (const [k, v] of res.headers) ctx.stdout(`${k}: ${v}\n`);
    ctx.stdout("\n");
  }
  if (silent) return 0;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json") && text !== "") {
    const json = JSON.parse(text) as unknown;
    ctx.stdout(render(jq ? applyPath(json, jq) : json));
  } else if (text !== "") {
    ctx.stdout(text.endsWith("\n") ? text : text + "\n");
  }
  return 0;
}

function splitKv(kv: string, sep: string): [string, string] {
  const i = kv.indexOf(sep);
  if (i <= 0) throw new UsageError(`bb api: expected key${sep}value, got "${kv}"`);
  return [kv.slice(0, i), kv.slice(i + 1)];
}

/** `-f a.b=c` → {a:{b:"c"}}; `-F n=3` → 3; `-F flag=true` → true; `-F body=@file` → file contents. */
export function buildBody(rawFields: string[], typedFields: string[], ctx: Pick<Context, "stdin">): Record<string, unknown> | undefined {
  if (rawFields.length === 0 && typedFields.length === 0) return undefined;
  const body: Record<string, unknown> = {};
  for (const kv of rawFields) {
    const [k, v] = splitKv(kv, "=");
    setPath(body, k, v);
  }
  for (const kv of typedFields) {
    const [k, v] = splitKv(kv, "=");
    setPath(body, k, typed(v, ctx));
  }
  return body;
}

function typed(v: string, ctx: Pick<Context, "stdin">): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("@")) return v === "@-" ? ctx.stdin() : readFileSync(v.slice(1), "utf8");
  return v;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const next = cur[k];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (last.endsWith("[]")) {
    const k = last.slice(0, -2);
    const arr = Array.isArray(cur[k]) ? (cur[k] as unknown[]) : [];
    arr.push(value);
    cur[k] = arr;
  } else cur[last] = value;
}

/** Tiny subset of jq: `.a.b`, `.values[]`, `.values[].title`, `.[0]`. */
export function applyPath(value: unknown, expr: string): unknown {
  let cur: unknown[] = [value];
  const path = expr.trim().replace(/^\./, "");
  if (path === "") return value;
  const tokens: string[] = path.match(/[^.[\]]+|\[\]|\[\d+\]/g) ?? [];
  for (const tok of tokens) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (tok === "[]") {
        if (Array.isArray(v)) next.push(...v);
        else if (v && typeof v === "object") next.push(...Object.values(v));
      } else if (/^\[\d+\]$/.test(tok)) {
        if (Array.isArray(v)) next.push(v[Number(tok.slice(1, -1))]);
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        next.push((v as Record<string, unknown>)[tok]);
      } else next.push(undefined);
    }
    cur = next;
  }
  const iterated = tokens.includes("[]");
  if (!iterated) return cur[0];
  return { __lines: cur };
}

function render(v: unknown): string {
  if (v && typeof v === "object" && "__lines" in v) {
    const lines = (v as { __lines: unknown[] }).__lines;
    return lines.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") + (lines.length ? "\n" : "");
  }
  if (typeof v === "string") return v + "\n";
  if (v === undefined) return "null\n";
  return JSON.stringify(v, null, 2) + "\n";
}

/** `{workspace}` / `{repo}` from the bitbucket.org remote of the current repository (origin first). */
async function fillPlaceholders(path: string, ctx: Context): Promise<string> {
  if (!/\{(workspace|repo)\}/.test(path)) return path;
  const repo = await currentRepo(ctx);
  if (!repo) throw new UsageError("bb api: {workspace}/{repo} placeholders need a bitbucket.org git remote in the current directory");
  return path.replace(/\{workspace\}/g, repo.workspace).replace(/\{repo\}/g, repo.slug);
}

export interface RepoRef {
  workspace: string;
  slug: string;
}

const REMOTE_RE = /(?:https?:\/\/(?:[^@/\s]+@)?bitbucket\.org\/|(?:ssh:\/\/)?git@bitbucket\.org[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

export function parseRemote(url: string): RepoRef | null {
  const m = REMOTE_RE.exec(url.trim());
  return m ? { workspace: m[1]!, slug: m[2]! } : null;
}

async function currentRepo(ctx: Context): Promise<RepoRef | null> {
  const out = await new Promise<string>((resolve) => {
    execFile("git", ["remote", "-v"], { env: ctx.env, encoding: "utf8" }, (err, stdout) => resolve(err ? "" : stdout));
  });
  const lines = out.split("\n").filter((l) => l.includes("(fetch)"));
  lines.sort((a, b) => Number(b.startsWith("origin\t")) - Number(a.startsWith("origin\t")));
  for (const line of lines) {
    const url = line.split(/\s+/)[1];
    const ref = url ? parseRemote(url) : null;
    if (ref) return ref;
  }
  return null;
}
