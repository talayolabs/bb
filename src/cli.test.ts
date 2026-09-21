import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { main } from "./cli.ts";
import { readHosts, writeHosts } from "./hosts.ts";
import { fakeFetch, json, testContext } from "./test-helpers.ts";

const me = { uuid: "{u1}", account_id: "557058:abc", display_name: "Alice A", nickname: "alice" };

test("auth login --with-token verifies via /2.0/user and stores the login", async () => {
  const { fetch, requests } = fakeFetch(() => json(200, me));
  const ctx = testContext({ fetch, stdin: "ATATT3xFfGF0secret\n" });
  assert.equal(await main(["auth", "login", "--with-token"], ctx), 0);
  assert.equal(requests[0]!.url, "https://api.bitbucket.org/2.0/user");
  assert.equal(requests[0]!.headers["authorization"], "Bearer ATATT3xFfGF0secret");
  const u = readHosts(join(ctx.configDir, "hosts.yml"))["bitbucket.org"]!.users[0]!;
  assert.deepEqual(u, {
    account: "alice",
    accountId: "557058:abc",
    gitUser: "x-bitbucket-api-token-auth",
    token: "ATATT3xFfGF0secret",
    expiresAt: null,
    refreshToken: null,
  });
  assert.match(ctx.err.join(""), /Logged in to bitbucket.org as alice \(git user: x-bitbucket-api-token-auth\)/);
});

test("auth login rejects a bad token with exit 4 and never echoes it", async () => {
  const { fetch } = fakeFetch(() => json(401, { type: "error", error: { message: "Token is invalid" } }));
  const ctx = testContext({ fetch, stdin: "ATATT3xFfGF0bad" });
  assert.equal(await main(["auth", "login", "--with-token"], ctx), 1);
  const err = ctx.err.join("");
  assert.match(err, /token rejected/);
  assert.match(err, /Token is invalid/);
  assert.ok(!err.includes("ATATT3xFfGF0bad"));
});

test("auth login without --with-token is a usage error pointing at the token page", async () => {
  const ctx = testContext();
  assert.equal(await main(["auth", "login"], ctx), 2);
  assert.match(ctx.err.join(""), /id\.atlassian\.com/);
});

test("auth login --skip-verify --user stores without a network call; --expires-at is kept", async () => {
  const ctx = testContext({ stdin: "oauth-access" });
  assert.equal(await main(["auth", "login", "--with-token", "--skip-verify", "--user", "bob", "--expires-at", "2026-09-21T14:00:00Z"], ctx), 0);
  const u = readHosts(join(ctx.configDir, "hosts.yml"))["bitbucket.org"]!.users[0]!;
  assert.equal(u.account, "bob");
  assert.equal(u.gitUser, "x-token-auth");
  assert.equal(u.expiresAt, "2026-09-21T14:00:00Z");
});

test("auth status / token / switch / logout across two logins", async () => {
  const ctx = testContext();
  const file = join(ctx.configDir, "hosts.yml");
  writeHosts(file, {
    "bitbucket.org": {
      active: "alice",
      users: [
        { account: "alice", accountId: "{u1}", gitUser: "x-token-auth", token: "alice-token-1234567890", expiresAt: "2026-09-21T14:00:00Z", refreshToken: "r" },
        { account: "bob", accountId: null, gitUser: "x-bitbucket-api-token-auth", token: "ATATT3xFfGF0bobtoken", expiresAt: null, refreshToken: null },
      ],
    },
  });

  assert.equal(await main(["auth", "status"], ctx), 0);
  let out = ctx.out.join("");
  assert.match(out, /Logged in to bitbucket.org account alice \(active\)/);
  assert.match(out, /Logged in to bitbucket.org account bob\n/);
  assert.match(out, /Expires: 2026-09-21T14:00:00Z \(in 2h\)/);
  assert.match(out, /Refresh: available/);
  assert.ok(!out.includes("alice-token-1234567890"));
  assert.match(out, /Token: \*{12}7890/);

  ctx.out.length = 0;
  assert.equal(await main(["auth", "status", "--show-token"], ctx), 0);
  assert.ok(ctx.out.join("").includes("alice-token-1234567890"));

  ctx.out.length = 0;
  assert.equal(await main(["auth", "token"], ctx), 0);
  assert.equal(ctx.out.join(""), "alice-token-1234567890\n");
  ctx.out.length = 0;
  assert.equal(await main(["auth", "token", "--user", "bob"], ctx), 0);
  assert.equal(ctx.out.join(""), "ATATT3xFfGF0bobtoken\n");

  assert.equal(await main(["auth", "switch"], ctx), 0);
  assert.equal(readHosts(file)["bitbucket.org"]!.active, "bob");
  assert.equal(await main(["auth", "switch", "--user", "nobody"], ctx), 4);

  assert.equal(await main(["auth", "logout"], ctx), 0);
  assert.equal(readHosts(file)["bitbucket.org"]!.active, "alice");
  assert.equal(await main(["auth", "logout", "--user", "alice"], ctx), 0);
  assert.equal(await main(["auth", "status"], ctx), 1);
  assert.equal(await main(["auth", "token"], ctx), 4);
});

test("auth status reports an expired token without refresh with exit 1", async () => {
  const ctx = testContext();
  writeHosts(join(ctx.configDir, "hosts.yml"), {
    "bitbucket.org": {
      active: "alice",
      users: [{ account: "alice", accountId: null, gitUser: "x-token-auth", token: "t", expiresAt: "2026-09-21T11:00:00Z", refreshToken: null }],
    },
  });
  assert.equal(await main(["auth", "status"], ctx), 1);
  assert.match(ctx.out.join(""), /✗ Token expired to bitbucket.org account alice \(active\)/);
});

test("auth status with BB_TOKEN reports the env source", async () => {
  const ctx = testContext({ env: { BB_TOKEN: "envtoken" } });
  assert.equal(await main(["auth", "status"], ctx), 0);
  assert.match(ctx.out.join(""), /Using token from BB_TOKEN \(git user: x-token-auth\)/);
  assert.ok(!ctx.out.join("").includes("envtoken"));
});

test("auth setup-git prints the helper config", async () => {
  const ctx = testContext();
  assert.equal(await main(["auth", "setup-git"], ctx), 0);
  assert.equal(ctx.out.join(""), "git config --global credential.https://bitbucket.org.helper '!bb auth git-credential'\n");
});

test("api GET prints JSON, honours -q, --jq and exit codes", async () => {
  const { fetch, requests } = fakeFetch(() => json(200, { values: [{ title: "A" }, { title: "B" }], size: 2 }));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "tok" } });
  assert.equal(await main(["api", "/repositories/ws/r/pullrequests", "-q", "state=OPEN", "-q", "pagelen=50"], ctx), 0);
  assert.equal(requests[0]!.url, "https://api.bitbucket.org/2.0/repositories/ws/r/pullrequests?state=OPEN&pagelen=50");
  assert.deepEqual(JSON.parse(ctx.out.join("")), { values: [{ title: "A" }, { title: "B" }], size: 2 });

  ctx.out.length = 0;
  assert.equal(await main(["api", "user", "--jq", ".values[].title"], ctx), 0);
  assert.equal(ctx.out.join(""), "A\nB\n");

  ctx.out.length = 0;
  assert.equal(await main(["api", "user", "--jq", ".size"], ctx), 0);
  assert.equal(ctx.out.join(""), "2\n");
});

test("api builds nested JSON bodies from -f/-F and defaults to POST", async () => {
  const { fetch, requests } = fakeFetch(() => json(201, { id: 7 }));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "tok" } });
  const code = await main(
    ["api", "/repositories/ws/r/pullrequests", "-f", "title=Fix it", "-f", "source.branch.name=fix", "-f", "destination.branch.name=main", "-F", "close_source_branch=true", "-F", "reviewers[]=x"],
    ctx,
  );
  assert.equal(code, 0);
  assert.equal(requests[0]!.method, "POST");
  assert.deepEqual(JSON.parse(requests[0]!.body!), {
    title: "Fix it",
    source: { branch: { name: "fix" } },
    destination: { branch: { name: "main" } },
    close_source_branch: true,
    reviewers: ["x"],
  });
});

test("api --input - reads JSON from stdin; -X overrides the method; --silent prints nothing", async () => {
  const { fetch, requests } = fakeFetch(() => json(200, { ok: true }));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "tok" }, stdin: '{"content":{"raw":"hi"}}' });
  assert.equal(await main(["api", "/repositories/ws/r/pullrequests/1/comments", "--input", "-", "-X", "PUT", "--silent"], ctx), 0);
  assert.equal(requests[0]!.method, "PUT");
  assert.equal(requests[0]!.body, '{"content":{"raw":"hi"}}');
  assert.equal(ctx.out.join(""), "");
});

test("api --paginate concatenates pages", async () => {
  const { fetch } = fakeFetch((req) =>
    req.url.includes("page=2") ? json(200, { values: [{ id: 3 }] }) : json(200, { values: [{ id: 1 }, { id: 2 }], next: "https://api.bitbucket.org/2.0/x?page=2" }),
  );
  const ctx = testContext({ fetch, env: { BB_TOKEN: "tok" } });
  assert.equal(await main(["api", "/x", "--paginate", "--jq", ".[].id"], ctx), 0);
  assert.equal(ctx.out.join(""), "1\n2\n3\n");
});

test("api -i prints status and headers", async () => {
  const { fetch } = fakeFetch(() => json(200, { a: 1 }, { "x-request-count": "1" }));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "tok" } });
  assert.equal(await main(["api", "user", "-i"], ctx), 0);
  const out = ctx.out.join("");
  assert.match(out, /^HTTP 200/);
  assert.match(out, /x-request-count: 1/);
  assert.match(out, /"a": 1/);
});

test("api maps errors to exit codes and messages", async () => {
  const { fetch } = fakeFetch(() => json(401, { error: { message: "Access token expired." } }));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "tok" } });
  assert.equal(await main(["api", "user"], ctx), 4);
  assert.match(ctx.err.join(""), /authentication failed \(401\).*Access token expired/);

  const rl = fakeFetch(() => json(429, {}, { "retry-after": "12" }));
  const ctx2 = testContext({ fetch: rl.fetch, env: { BB_TOKEN: "tok" } });
  assert.equal(await main(["api", "user"], ctx2), 1);
  assert.match(ctx2.err.join(""), /rate limited \(429\), retry after 12s/);

  const ctx3 = testContext();
  assert.equal(await main(["api", "user"], ctx3), 4);
  assert.match(ctx3.err.join(""), /not logged in/);

  const ctx4 = testContext({ env: { BB_TOKEN: "tok" } });
  assert.equal(await main(["api", "user", "-H", "Authorization: Bearer x"], ctx4), 2);
  assert.equal(await main(["api"], ctx4), 2);
  assert.equal(await main(["api", "user", "--bogus"], ctx4), 2);
});

test("api --verbose logs requests without the token", async () => {
  const { fetch } = fakeFetch(() => json(200, {}));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "supersecret" } });
  assert.equal(await main(["api", "user", "--verbose"], ctx), 0);
  assert.deepEqual(ctx.debugLines, ["> GET https://api.bitbucket.org/2.0/user", "< 200 "]);
});

test("help and version", async () => {
  const ctx = testContext();
  assert.equal(await main([], ctx), 2);
  assert.match(ctx.out.join(""), /USAGE/);
  assert.equal(await main(["--help"], ctx), 0);
  assert.equal(await main(["help", "api"], ctx), 0);
  assert.match(ctx.out.join(""), /bb api <path>/);
  assert.equal(await main(["nope"], ctx), 2);
  ctx.out.length = 0;
  assert.equal(await main(["--version"], ctx), 0);
  assert.match(ctx.out.join(""), /^bb \d+\.\d+\.\d+/);
});
