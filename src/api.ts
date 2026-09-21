import { API_BASE } from "./config.ts";

export type FetchLike = typeof fetch;

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly body: string;
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string, status: number, body: string, retryAfterSeconds: number | null) {
    super(describe(method, url, status, body, retryAfterSeconds));
    this.name = "ApiError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get kind(): "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "server" | "other" {
    if (this.status === 401) return "unauthorized";
    if (this.status === 403) return "forbidden";
    if (this.status === 404) return "not_found";
    if (this.status === 429) return "rate_limited";
    if (this.status >= 500) return "server";
    return "other";
  }
}

function describe(method: string, url: string, status: number, body: string, retryAfter: number | null): string {
  const path = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
  const message = errorMessage(body);
  let head: string;
  switch (status) {
    case 401:
      head = "authentication failed (401): token missing, expired or revoked";
      break;
    case 403:
      head = "forbidden (403): the token's scopes or the account's permissions don't allow this";
      break;
    case 404:
      head = "not found (404): wrong workspace/repository, or no read access";
      break;
    case 429:
      head = `rate limited (429)${retryAfter !== null ? `, retry after ${retryAfter}s` : ""}`;
      break;
    default:
      head = `HTTP ${status}`;
  }
  return `${method} ${path}: ${head}${message ? ` — ${message}` : ""}`;
}

/** Bitbucket errors are `{ "type": "error", "error": { "message": "..." } }`; be lenient. */
export function errorMessage(body: string): string | null {
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown; detail?: unknown }; message?: unknown };
    const msg = json.error?.message ?? json.message;
    if (typeof msg === "string") {
      const detail = json.error?.detail;
      return typeof detail === "string" && detail !== msg ? `${msg} (${detail})` : msg;
    }
  } catch {
    /* not JSON */
  }
  const text = body.trim();
  return text === "" || text.startsWith("<") ? null : text.slice(0, 300);
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Raw body with its content type, for `--input` files that are not JSON. */
  raw?: { body: string; contentType: string };
  headers?: Record<string, string>;
}

export interface Page<T> {
  values: T[];
  next?: string;
  size?: number;
  page?: number;
  pagelen?: number;
}

export interface ClientOptions {
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  userAgent?: string;
  /** Receives one line per request/response; `Authorization` is never included. */
  log?: (line: string) => void;
}

/** Thin Bearer-authenticated client for `https://api.bitbucket.org/2.0`. */
export class BitbucketClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly log: ((line: string) => void) | null;

  constructor(opts: ClientOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = (opts.baseUrl ?? API_BASE).replace(/\/$/, "");
    this.userAgent = opts.userAgent ?? "bb";
    this.log = opts.log ?? null;
  }

  /** `path` is relative to `/2.0` (with or without the leading `/2.0`), or an absolute `https://api.bitbucket.org/...` URL. */
  url(path: string, query?: Record<string, string | undefined>): string {
    let url: URL;
    if (/^https?:\/\//i.test(path)) {
      url = new URL(path);
      if (url.origin !== new URL(this.baseUrl).origin) throw new Error(`refusing to send the token to ${url.origin}`);
    } else {
      const rel = path.replace(/^\/?2\.0(?=\/|$)/, "").replace(/^\/?/, "/");
      url = new URL(this.baseUrl + rel);
    }
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    return url.toString();
  }

  async raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const method = (opts.method ?? (opts.body !== undefined || opts.raw ? "POST" : "GET")).toUpperCase();
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...opts.headers,
    };
    let body: string | null = null;
    if (opts.raw) {
      body = opts.raw.body;
      headers["Content-Type"] = opts.raw.contentType;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    this.log?.(`> ${method} ${url}`);
    const res = await this.fetchImpl(url, { method, headers, body, redirect: "manual" });
    this.log?.(`< ${res.status} ${res.statusText}`);
    if (!res.ok) {
      const text = await res.text();
      const ra = res.headers.get("retry-after");
      const retryAfter = ra !== null && /^\d+$/.test(ra) ? Number(ra) : null;
      throw new ApiError(method, url, res.status, text, retryAfter);
    }
    return res;
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(path, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text === "") return undefined as T;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) return JSON.parse(text) as T;
    return text as unknown as T;
  }

  /** Follows `next` links (opaque URLs) and yields every value. */
  async *paginate<T>(path: string, opts: RequestOptions = {}): AsyncGenerator<T, void, void> {
    let url: string | undefined = this.url(path, opts.query);
    while (url) {
      const { query: _query, ...rest } = opts;
      const page: Page<T> = await this.request<Page<T>>(url, rest);
      if (!page || !Array.isArray(page.values)) throw new Error(`${path}: response is not a paginated list`);
      for (const v of page.values) yield v;
      url = page.next;
    }
  }

  async all<T>(path: string, opts: RequestOptions = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const v of this.paginate<T>(path, opts)) out.push(v);
    return out;
  }
}

/** `GET /2.0/user` fields bb cares about. */
export interface BitbucketUser {
  uuid: string;
  account_id?: string;
  display_name: string;
  nickname: string;
  links?: { avatar?: { href?: string }; html?: { href?: string } };
}

export function fetchCurrentUser(client: BitbucketClient): Promise<BitbucketUser> {
  return client.request<BitbucketUser>("/user");
}
