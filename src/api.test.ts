import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, BitbucketClient, errorMessage } from "./api.ts";
import { fakeFetch, json } from "./test-helpers.ts";

test("builds URLs from relative paths, /2.0-prefixed paths and absolute next links", () => {
  const c = new BitbucketClient({ token: "t" });
  assert.equal(c.url("user"), "https://api.bitbucket.org/2.0/user");
  assert.equal(c.url("/user"), "https://api.bitbucket.org/2.0/user");
  assert.equal(c.url("/2.0/user"), "https://api.bitbucket.org/2.0/user");
  assert.equal(c.url("2.0/repositories/ws/r"), "https://api.bitbucket.org/2.0/repositories/ws/r");
  assert.equal(c.url("/repositories/ws/r/pullrequests", { state: "OPEN", q: undefined }), "https://api.bitbucket.org/2.0/repositories/ws/r/pullrequests?state=OPEN");
  assert.equal(c.url("https://api.bitbucket.org/2.0/repositories?page=2"), "https://api.bitbucket.org/2.0/repositories?page=2");
  assert.throws(() => c.url("https://evil.example/2.0/user"), /refusing to send the token/);
});

test("sends Bearer auth and JSON bodies, defaults to POST when a body is given", async () => {
  const { fetch, requests } = fakeFetch(() => json(201, { id: 1 }));
  const c = new BitbucketClient({ token: "secret-token", fetch });
  const out = await c.request<{ id: number }>("/repositories/ws/r/pullrequests", { body: { title: "x" } });
  assert.deepEqual(out, { id: 1 });
  const req = requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.headers["authorization"], "Bearer secret-token");
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers["accept"], "application/json");
  assert.equal(req.body, '{"title":"x"}');
});

test("the request log never contains the token", async () => {
  const lines: string[] = [];
  const { fetch } = fakeFetch(() => json(200, {}));
  const c = new BitbucketClient({ token: "secret-token", fetch, log: (l) => lines.push(l) });
  await c.request("/user");
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.ok(!l.includes("secret-token"), l);
});

test("paginate follows opaque next links and yields every value", async () => {
  const { fetch, requests } = fakeFetch((req) =>
    req.url.includes("page=2")
      ? json(200, { values: [3], pagelen: 2, page: 2 })
      : json(200, { values: [1, 2], pagelen: 2, page: 1, next: "https://api.bitbucket.org/2.0/things?page=2&pagelen=2" }),
  );
  const c = new BitbucketClient({ token: "t", fetch });
  assert.deepEqual(await c.all<number>("/things", { query: { pagelen: "2" } }), [1, 2, 3]);
  assert.deepEqual(
    requests.map((r) => r.url),
    ["https://api.bitbucket.org/2.0/things?pagelen=2", "https://api.bitbucket.org/2.0/things?page=2&pagelen=2"],
  );
});

test("paginate rejects non-list responses", async () => {
  const { fetch } = fakeFetch(() => json(200, { display_name: "x" }));
  const c = new BitbucketClient({ token: "t", fetch });
  await assert.rejects(c.all("/user"), /not a paginated list/);
});

test("classifies 401/403/404/429 and reads Retry-After", async () => {
  const cases: Array<[number, RegExp, string]> = [
    [401, /authentication failed \(401\)/, "unauthorized"],
    [403, /forbidden \(403\)/, "forbidden"],
    [404, /not found \(404\)/, "not_found"],
    [429, /rate limited \(429\), retry after 30s/, "rate_limited"],
    [500, /HTTP 500/, "server"],
  ];
  for (const [status, re, kind] of cases) {
    const { fetch } = fakeFetch(() => json(status, { type: "error", error: { message: "Nope" } }, status === 429 ? { "retry-after": "30" } : {}));
    const c = new BitbucketClient({ token: "t", fetch });
    const err = await c.request("/repositories/ws/r").catch((e: unknown) => e);
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, status);
    assert.equal(err.kind, kind);
    assert.match(err.message, re);
    assert.match(err.message, /Nope/);
    assert.match(err.message, /^GET \/repositories\/ws\/r:/);
    assert.equal(err.retryAfterSeconds, status === 429 ? 30 : null);
  }
});

test("errorMessage handles Bitbucket's shape, plain text and HTML", () => {
  assert.equal(errorMessage('{"type":"error","error":{"message":"Bad","detail":"more"}}'), "Bad (more)");
  assert.equal(errorMessage('{"message":"x"}'), "x");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage("<html>nope</html>"), null);
  assert.equal(errorMessage(""), null);
});

test("204 and empty bodies resolve to undefined; non-JSON bodies come back as text", async () => {
  let { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(await new BitbucketClient({ token: "t", fetch }).request("/x", { method: "DELETE" }), undefined);
  ({ fetch } = fakeFetch(() => new Response("diff --git", { status: 200, headers: { "content-type": "text/plain" } })));
  assert.equal(await new BitbucketClient({ token: "t", fetch }).request("/x"), "diff --git");
});
