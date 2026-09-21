import { baseUrl } from "./config.ts";

export type FetchLike = typeof fetch;

/** Default REST root; `bb api projects/…` is relative to it. Other roots (`/rest/build-status/latest`, …) are reached with an explicit `rest/…` path. */
export const CORE_API_PREFIX = "/rest/api/latest";

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

/** A request that never got an HTTP response (DNS, TCP, TLS); `code` is Node's, e.g. ENOTFOUND or SELF_SIGNED_CERT_IN_CHAIN. */
export class NetworkError extends Error {
  readonly code: string | null;
  readonly host: string;

  constructor(host: string, cause: unknown) {
    const code = errorCode(cause);
    super(describeNetwork(host, code, cause));
    this.name = "NetworkError";
    this.host = host;
    this.code = code;
  }
}

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function errorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") return (e as { code: string }).code;
    e = e instanceof Error ? e.cause : null;
  }
  return null;
}

function describeNetwork(host: string, code: string | null, cause: unknown): string {
  const root = (() => {
    let e: unknown = cause;
    while (e instanceof Error && e.cause) e = e.cause;
    return e instanceof Error ? e.message : String(e);
  })();
  if (code && TLS_CODES.has(code)) {
    return (
      `could not verify the TLS certificate of ${host} (${code}).\n` +
      `If a proxy such as Cloudflare WARP or Zscaler re-signs traffic, point Node at its root CA:\n` +
      `  export NODE_EXTRA_CA_CERTS=/path/to/proxy-root-ca.pem   # or: export NODE_OPTIONS=--use-system-ca`
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `could not resolve ${host} (${code}): check the hostname, VPN or DNS`;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `could not connect to ${host} (${code}): check the VPN, proxy or firewall`;
  }
  return `could not reach ${host}: ${root}${code ? ` (${code})` : ""}`;
}

function describe(method: string, url: string, status: number, body: string, retryAfter: number | null): string {
  let path = url;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    /* keep as is */
  }
  const message = errorMessage(body);
  let head: string;
  switch (status) {
    case 401:
      head = "authentication failed (401): token missing, expired or revoked";
      break;
    case 403:
      head = "forbidden (403): the token's permissions or the account's don't allow this";
      break;
    case 404:
      head = "not found (404): wrong project/repository, or no read access";
      break;
    case 429:
      head = `rate limited (429)${retryAfter !== null ? `, retry after ${retryAfter}s` : ""}`;
      break;
    default:
      head = `HTTP ${status}`;
  }
  return `${method} ${path}: ${head}${message ? ` — ${message}` : ""}`;
}

/** Data Center errors are `{ "errors": [{ "message": "...", "context": ..., "exceptionName": ... }] }`; be lenient. */
export function errorMessage(body: string): string | null {
  try {
    const json = JSON.parse(body) as { errors?: Array<{ message?: unknown }>; message?: unknown; error?: { message?: unknown } };
    const fromList = json.errors?.map((e) => e.message).filter((m): m is string => typeof m === "string");
    if (fromList && fromList.length) return fromList.join("; ");
    const msg = json.message ?? json.error?.message;
    if (typeof msg === "string") return msg;
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

/** Data Center's page envelope. */
export interface Page<T> {
  values: T[];
  size?: number;
  limit?: number;
  isLastPage?: boolean;
  start?: number;
  nextPageStart?: number;
}

export interface ClientOptions {
  host: string;
  token: string;
  fetch?: FetchLike;
  userAgent?: string;
  /** Receives one line per request/response; `Authorization` is never included. */
  log?: (line: string) => void;
}

/** Thin Bearer-authenticated client for one Bitbucket Data Center instance. */
export class BitbucketClient {
  readonly host: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly origin: string;
  private readonly userAgent: string;
  private readonly log: ((line: string) => void) | null;

  constructor(opts: ClientOptions) {
    this.origin = baseUrl(opts.host);
    this.host = new URL(this.origin).host;
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
    this.userAgent = opts.userAgent ?? "bb";
    this.log = opts.log ?? null;
  }

  /**
   * `path` is relative to `/rest/api/latest` ("projects/KEY/repos/slug"), an explicit REST path
   * ("rest/build-status/latest/…"), or an absolute URL on this host.
   */
  url(path: string, query?: Record<string, string | undefined>): string {
    let url: URL;
    if (/^https?:\/\//i.test(path)) {
      url = new URL(path);
      if (url.origin !== this.origin) throw new Error(`refusing to send the token to ${url.origin}`);
    } else {
      const rel = path.replace(/^\/+/, "");
      url = new URL(rel.startsWith("rest/") ? `${this.origin}/${rel}` : `${this.origin}${CORE_API_PREFIX}/${rel}`);
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
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, redirect: "manual" });
    } catch (err) {
      throw new NetworkError(this.host, err);
    }
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

  /** Follows `nextPageStart` until `isLastPage` and yields every value. */
  async *paginate<T>(path: string, opts: RequestOptions = {}): AsyncGenerator<T, void, void> {
    const { query, ...rest } = opts;
    let start: number | undefined = query?.start !== undefined ? Number(query.start) : undefined;
    for (;;) {
      const q: Record<string, string | undefined> = { ...query };
      if (start !== undefined) q.start = String(start);
      const page: Page<T> = await this.request<Page<T>>(path, { ...rest, query: q });
      if (!page || !Array.isArray(page.values)) throw new Error(`${path}: response is not a paginated list`);
      for (const v of page.values) yield v;
      if (page.isLastPage !== false || page.nextPageStart === undefined) return;
      start = page.nextPageStart;
    }
  }

  async all<T>(path: string, opts: RequestOptions = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const v of this.paginate<T>(path, opts)) out.push(v);
    return out;
  }
}

/** `GET /rest/api/latest/users/{slug}` fields bb cares about. */
export interface BitbucketUser {
  id: number;
  name: string;
  slug: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  type?: "NORMAL" | "SERVICE";
}

/**
 * Data Center has no "current user" endpoint; every authenticated response carries the user's
 * name in `X-AUSERNAME`. Ask for something cheap that needs a login, then fetch the profile.
 */
export async function fetchCurrentUser(client: BitbucketClient, slugHint?: string): Promise<BitbucketUser> {
  let slug = slugHint;
  if (!slug) {
    const res = await client.raw("inbox/pull-requests/count");
    slug = res.headers.get("x-ausername") ?? undefined;
    if (!slug) throw new Error(`${client.host} accepted the token but did not report a user (no X-AUSERNAME); pass --user <name>`);
  }
  const user = await client.request<unknown>(`users/${encodeURIComponent(slug)}`);
  if (!isUser(user)) throw new Error(`${client.host}: GET /users/${slug} did not return a user; is this a Bitbucket Data Center instance?`);
  return user;
}

function isUser(v: unknown): v is BitbucketUser {
  return typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string" && typeof (v as { id?: unknown }).id === "number";
}
