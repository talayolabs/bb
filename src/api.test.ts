import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, BitbucketClient, errorMessage, fetchCurrentUser } from "./api.ts";
import { fakeFetch, json } from "./test-helpers.ts";

const HOST = "bitbucket.example.com";
const CORE = `https://${HOST}/rest/api/latest`;

test("builds URLs relative to /rest/api/latest, from explicit rest/ paths and from absolute URLs on the host", () => {
  const c = new BitbucketClient({ host: "https://Bitbucket.Example.com:443/", token: "t" });
  assert.equal(c.host, HOST);
  assert.equal(c.url("projects/KEY/repos/r"), `${CORE}/projects/KEY/repos/r`);
  assert.equal(c.url("/projects/KEY/repos/r"), `${CORE}/projects/KEY/repos/r`);
  assert.equal(c.url("/projects/KEY/repos/r/pull-requests", { state: "OPEN", q: undefined }), `${CORE}/projects/KEY/repos/r/pull-requests?state=OPEN`);
  assert.equal(c.url("rest/build-status/latest/commits/abc"), `https://${HOST}/rest/build-status/latest/commits/abc`);
  assert.equal(c.url("/rest/api/1.0/users/me"), `https://${HOST}/rest/api/1.0/users/me`);
  assert.equal(c.url(`${CORE}/projects?start=25`), `${CORE}/projects?start=25`);
  assert.throws(() => c.url("https://evil.example/rest/api/latest/users"), /refusing to send the token/);
  assert.throws(() => c.url(`http://${HOST}/rest/api/latest/users`), /refusing to send the token/);
});

test("sends Bearer auth and JSON bodies, defaults to POST when a body is given", async () => {
  const { fetch, requests } = fakeFetch(() => json(201, { id: 1 }));
  const c = new BitbucketClient({ host: HOST, token: "secret-token", fetch });
  const out = await c.request<{ id: number }>("projects/KEY/repos/r/pull-requests", { body: { title: "x" } });
  assert.deepEqual(out, { id: 1 });
  const req = requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.url, `${CORE}/projects/KEY/repos/r/pull-requests`);
  assert.equal(req.headers["authorization"], "Bearer secret-token");
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers["accept"], "application/json");
  assert.equal(req.body, '{"title":"x"}');
});

test("the request log never contains the token", async () => {
  const lines: string[] = [];
  const { fetch } = fakeFetch(() => json(200, {}));
  const c = new BitbucketClient({ host: HOST, token: "secret-token", fetch, log: (l) => lines.push(l) });
  await c.request("projects");
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.ok(!l.includes("secret-token"), l);
});

test("paginate follows nextPageStart until isLastPage and yields every value", async () => {
  const { fetch, requests } = fakeFetch((req) => {
    const start = new URL(req.url).searchParams.get("start");
    if (start === "2") return json(200, { values: [3, 4], size: 2, limit: 2, isLastPage: false, start: 2, nextPageStart: 4 });
    if (start === "4") return json(200, { values: [5], size: 1, limit: 2, isLastPage: true, start: 4 });
    return json(200, { values: [1, 2], size: 2, limit: 2, isLastPage: false, start: 0, nextPageStart: 2 });
  });
  const c = new BitbucketClient({ host: HOST, token: "t", fetch });
  assert.deepEqual(await c.all<number>("projects", { query: { limit: "2" } }), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    requests.map((r) => r.url),
    [`${CORE}/projects?limit=2`, `${CORE}/projects?limit=2&start=2`, `${CORE}/projects?limit=2&start=4`],
  );
});

test("paginate stops on a page without isLastPage and rejects non-list responses", async () => {
  let { fetch } = fakeFetch(() => json(200, { values: [1] }));
  assert.deepEqual(await new BitbucketClient({ host: HOST, token: "t", fetch }).all<number>("projects"), [1]);
  ({ fetch } = fakeFetch(() => json(200, { displayName: "x" })));
  await assert.rejects(new BitbucketClient({ host: HOST, token: "t", fetch }).all("users/x"), /not a paginated list/);
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
    const { fetch } = fakeFetch(() =>
      json(status, { errors: [{ context: null, message: "Nope", exceptionName: "x" }] }, status === 429 ? { "retry-after": "30" } : {}),
    );
    const c = new BitbucketClient({ host: HOST, token: "t", fetch });
    const err = await c.request("projects/KEY/repos/r").catch((e: unknown) => e);
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, status);
    assert.equal(err.kind, kind);
    assert.match(err.message, re);
    assert.match(err.message, /Nope/);
    assert.match(err.message, /^GET \/rest\/api\/latest\/projects\/KEY\/repos\/r:/);
    assert.equal(err.retryAfterSeconds, status === 429 ? 30 : null);
  }
});

test("errorMessage handles Data Center's errors list, plain text and HTML", () => {
  assert.equal(errorMessage('{"errors":[{"message":"Bad"},{"message":"Worse"}]}'), "Bad; Worse");
  assert.equal(errorMessage('{"message":"x"}'), "x");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage("<html>nope</html>"), null);
  assert.equal(errorMessage(""), null);
});

test("204 and empty bodies resolve to undefined; non-JSON bodies come back as text", async () => {
  let { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(await new BitbucketClient({ host: HOST, token: "t", fetch }).request("x", { method: "DELETE" }), undefined);
  ({ fetch } = fakeFetch(() => new Response("diff --git", { status: 200, headers: { "content-type": "text/plain" } })));
  assert.equal(await new BitbucketClient({ host: HOST, token: "t", fetch }).request("x"), "diff --git");
});

test("fetchCurrentUser reads X-AUSERNAME from an authenticated call, then loads the profile", async () => {
  const { fetch, requests } = fakeFetch((req) =>
    req.url.endsWith("/inbox/pull-requests/count")
      ? json(200, { count: 0 }, { "x-ausername": "Alice.Smith" })
      : json(200, { id: 101, name: "Alice.Smith", slug: "alice.smith", displayName: "Alice Smith" }),
  );
  const me = await fetchCurrentUser(new BitbucketClient({ host: HOST, token: "t", fetch }));
  assert.equal(me.name, "Alice.Smith");
  assert.equal(me.id, 101);
  assert.deepEqual(
    requests.map((r) => r.url),
    [`${CORE}/inbox/pull-requests/count`, `${CORE}/users/Alice.Smith`],
  );
});

test("fetchCurrentUser fails clearly without X-AUSERNAME and skips the probe when a name is given", async () => {
  let { fetch } = fakeFetch(() => json(200, { count: 0 }));
  await assert.rejects(fetchCurrentUser(new BitbucketClient({ host: HOST, token: "t", fetch })), /did not report a user.*--user/);
  const probe = fakeFetch(() => json(200, { id: 7, name: "bob", slug: "bob", displayName: "Bob" }));
  fetch = probe.fetch;
  const me = await fetchCurrentUser(new BitbucketClient({ host: HOST, token: "t", fetch }), "bob");
  assert.equal(me.id, 7);
  assert.deepEqual(probe.requests.map((r) => r.url), [`${CORE}/users/bob`]);
});
