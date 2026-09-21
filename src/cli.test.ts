import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { main } from "./cli.ts";
import { readHosts, writeHosts } from "./hosts.ts";
import { fakeFetch, json, testContext, type FakeRequest } from "./test-helpers.ts";

const HOST = "bitbucket.example.com";
const CORE = `https://${HOST}/rest/api/latest`;
const me = { id: 101, name: "Alice.Smith", slug: "alice.smith", displayName: "Alice Smith", active: true };

/** A Data Center that knows one user and reports it in X-AUSERNAME. */
function dcFetch(token = "MDM0MjM5NDc2MDsecret") {
  return fakeFetch((req: FakeRequest) => {
    if (req.headers["authorization"] !== `Bearer ${token}`) return json(401, { errors: [{ message: "Authentication failed" }] });
    if (req.url === `${CORE}/inbox/pull-requests/count`) return json(200, { count: 0 }, { "x-ausername": me.name });
    if (req.url === `${CORE}/users/${me.name}`) return json(200, me);
    return json(404, { errors: [{ message: "nope" }] });
  });
}

test("auth login --with-token verifies the token, learns the username and stores the login", async () => {
  const { fetch, requests } = dcFetch();
  const ctx = testContext({ fetch, stdin: "MDM0MjM5NDc2MDsecret\n" });
  assert.equal(await main(["auth", "login", "--hostname", `https://${HOST}/`, "--with-token"], ctx), 0);
  assert.deepEqual(
    requests.map((r) => r.url),
    [`${CORE}/inbox/pull-requests/count`, `${CORE}/users/Alice.Smith`],
  );
  const u = readHosts(join(ctx.configDir, "hosts.yml"))[HOST]!.users[0]!;
  assert.deepEqual(u, { account: "Alice.Smith", accountId: "101", gitUser: "Alice.Smith", token: "MDM0MjM5NDc2MDsecret", expiresAt: null });
  assert.match(ctx.err.join(""), /Logged in to bitbucket.example.com as Alice.Smith \(git user: Alice.Smith\)/);
  assert.ok(!ctx.err.join("").includes("MDM0MjM5NDc2MDsecret"));
});

test("auth login in a terminal opens the token page and reads the pasted token without echo", async () => {
  const { fetch } = dcFetch();
  const ctx = testContext({ fetch, interactive: true, secret: "  MDM0MjM5NDc2MDsecret\n" });
  assert.equal(await main(["auth", "login", "--hostname", HOST], ctx), 0);
  assert.deepEqual(ctx.opened, [`https://${HOST}/plugins/servlet/access-tokens/manage`]);
  assert.deepEqual(ctx.prompts, ["Paste the token here: "]);
  const err = ctx.err.join("");
  assert.match(err, /Repository → Write/);
  assert.match(err, /Opened https:\/\/bitbucket\.example\.com\/plugins\/servlet\/access-tokens\/manage/);
  assert.equal(readHosts(join(ctx.configDir, "hosts.yml"))[HOST]!.users[0]!.token, "MDM0MjM5NDc2MDsecret");
});

test("auth login --no-browser (or no opener) prints the URL instead; BB_HOST supplies the host", async () => {
  const { fetch } = dcFetch();
  const ctx = testContext({ fetch, interactive: true, secret: "MDM0MjM5NDc2MDsecret", env: { BB_HOST: HOST } });
  assert.equal(await main(["auth", "login", "--no-browser"], ctx), 0);
  assert.deepEqual(ctx.opened, []);
  assert.match(ctx.err.join(""), /Open https:\/\/bitbucket\.example\.com\/plugins\/servlet\/access-tokens\/manage in your browser/);

  const ctx2 = testContext({ fetch: dcFetch().fetch, interactive: true, secret: "MDM0MjM5NDc2MDsecret", browserOpens: false });
  assert.equal(await main(["auth", "login", "--hostname", HOST], ctx2), 0);
  assert.match(ctx2.err.join(""), /Open https:\/\/.* in your browser/);
});

test("auth login without a host or without a terminal is a usage error", async () => {
  const ctx = testContext({ interactive: true });
  assert.equal(await main(["auth", "login"], ctx), 2);
  assert.match(ctx.err.join(""), /--hostname <host> is required/);
  const ctx2 = testContext({ interactive: false });
  assert.equal(await main(["auth", "login", "--hostname", HOST], ctx2), 2);
  assert.match(ctx2.err.join(""), /not a terminal.*--with-token/);
  assert.equal(await main(["auth", "login", "--hostname", HOST, "--with-token"], testContext({ stdin: "\n" })), 2);
});

test("auth login rejects a bad token with exit 1 and never echoes it", async () => {
  const { fetch } = dcFetch("other");
  const ctx = testContext({ fetch, stdin: "MDM0MjM5NDc2MDbad" });
  assert.equal(await main(["auth", "login", "--hostname", HOST, "--with-token"], ctx), 1);
  const err = ctx.err.join("");
  assert.match(err, /token rejected by bitbucket.example.com/);
  assert.match(err, /Authentication failed/);
  assert.match(err, /--skip-verify --user/);
  assert.ok(!err.includes("MDM0MjM5NDc2MDbad"));
});

test("auth login --user skips the X-AUSERNAME probe; --git-user overrides the git username", async () => {
  const { fetch, requests } = dcFetch();
  const ctx = testContext({ fetch, stdin: "MDM0MjM5NDc2MDsecret" });
  assert.equal(await main(["auth", "login", "--hostname", HOST, "--with-token", "--user", "Alice.Smith", "--git-user", "x-token-auth"], ctx), 0);
  assert.deepEqual(requests.map((r) => r.url), [`${CORE}/users/Alice.Smith`]);
  assert.equal(readHosts(join(ctx.configDir, "hosts.yml"))[HOST]!.users[0]!.gitUser, "x-token-auth");
});

test("auth login --skip-verify --user stores without a network call; --expires-at is kept", async () => {
  const ctx = testContext({ stdin: "sometoken" });
  assert.equal(await main(["auth", "login", "--hostname", HOST, "--with-token", "--skip-verify", "--user", "bob", "--expires-at", "2026-09-21T14:00:00Z"], ctx), 0);
  const u = readHosts(join(ctx.configDir, "hosts.yml"))[HOST]!.users[0]!;
  assert.deepEqual(u, { account: "bob", accountId: null, gitUser: "bob", token: "sometoken", expiresAt: "2026-09-21T14:00:00Z" });
  assert.equal(await main(["auth", "login", "--hostname", HOST, "--with-token", "--skip-verify"], testContext({ stdin: "t" })), 2);
});

test("auth status / token / switch / logout across two logins on one host", async () => {
  const ctx = testContext();
  const file = join(ctx.configDir, "hosts.yml");
  writeHosts(file, {
    [HOST]: {
      active: "alice",
      users: [
        { account: "alice", accountId: "101", gitUser: "alice", token: "alice-token-1234567890", expiresAt: "2026-09-21T14:00:00Z" },
        { account: "bob", accountId: null, gitUser: "x-token-auth", token: "bob-token", expiresAt: null },
      ],
    },
  });

  assert.equal(await main(["auth", "status"], ctx), 0);
  let out = ctx.out.join("");
  assert.match(out, /^bitbucket\.example\.com\n/);
  assert.match(out, /! Token expiring to bitbucket.example.com account alice \(active\)/);
  assert.match(out, /Logged in to bitbucket.example.com account bob\n/);
  assert.match(out, /Account id: 101/);
  assert.match(out, /Git user: alice/);
  assert.match(out, /Expires: 2026-09-21T14:00:00Z \(in 2h\)/);
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
  assert.equal(ctx.out.join(""), "bob-token\n");

  assert.equal(await main(["auth", "switch"], ctx), 0);
  assert.equal(readHosts(file)[HOST]!.active, "bob");
  assert.equal(await main(["auth", "switch", "--user", "nobody"], ctx), 4);

  assert.equal(await main(["auth", "logout"], ctx), 0);
  assert.equal(readHosts(file)[HOST]!.active, "alice");
  assert.equal(await main(["auth", "logout", "--user", "alice"], ctx), 0);
  assert.equal(await main(["auth", "status"], ctx), 1);
  assert.equal(await main(["auth", "token"], ctx), 4);
});

test("with several hosts, --hostname / BB_HOST select one and their absence is an error", async () => {
  const ctx = testContext();
  writeHosts(join(ctx.configDir, "hosts.yml"), {
    [HOST]: { active: "alice", users: [{ account: "alice", accountId: null, gitUser: "alice", token: "t-one", expiresAt: null }] },
    "git.other.example": { active: "bob", users: [{ account: "bob", accountId: null, gitUser: "bob", token: "t-two", expiresAt: null }] },
  });
  assert.equal(await main(["auth", "token"], ctx), 4);
  assert.match(ctx.err.join(""), /several hosts are logged in \(bitbucket.example.com, git.other.example\)/);

  ctx.out.length = 0;
  assert.equal(await main(["auth", "token", "--hostname", "GIT.other.example"], ctx), 0);
  assert.equal(ctx.out.join(""), "t-two\n");
  ctx.out.length = 0;
  assert.equal(await main(["auth", "token"], { ...ctx, env: { ...ctx.env, BB_HOST: HOST } }), 0);
  assert.equal(ctx.out.join(""), "t-one\n");

  ctx.out.length = 0;
  assert.equal(await main(["auth", "status", "--hostname", HOST], ctx), 0);
  assert.ok(!ctx.out.join("").includes("git.other.example"));
  assert.equal(await main(["auth", "status", "--hostname", "nowhere.example"], ctx), 1);
  assert.match(ctx.err.join(""), /not logged in to nowhere.example/);
});

test("auth status reports an expired token with exit 1", async () => {
  const ctx = testContext();
  writeHosts(join(ctx.configDir, "hosts.yml"), {
    [HOST]: { active: "alice", users: [{ account: "alice", accountId: null, gitUser: "alice", token: "t", expiresAt: "2026-09-21T11:00:00Z" }] },
  });
  assert.equal(await main(["auth", "status"], ctx), 1);
  assert.match(ctx.out.join(""), /✗ Token expired to bitbucket.example.com account alice \(active\)/);
});

test("auth status with BB_TOKEN reports the env source", async () => {
  const ctx = testContext({ env: { BB_TOKEN: "envtoken", BB_HOST: HOST, BB_GIT_USER: "alice" } });
  assert.equal(await main(["auth", "status"], ctx), 0);
  assert.match(ctx.out.join(""), /^bitbucket\.example\.com\n  ✓ Using token from BB_TOKEN \(git user: alice\)/);
  assert.ok(!ctx.out.join("").includes("envtoken"));
});

test("auth setup-git prints the helper config for each host", async () => {
  const ctx = testContext();
  writeHosts(join(ctx.configDir, "hosts.yml"), {
    [HOST]: { active: "alice", users: [{ account: "alice", accountId: null, gitUser: "alice", token: "t", expiresAt: null }] },
  });
  assert.equal(await main(["auth", "setup-git"], ctx), 0);
  assert.equal(ctx.out.join(""), `git config --global credential.https://${HOST}.helper '!bb auth git-credential'\n`);
  ctx.out.length = 0;
  assert.equal(await main(["auth", "setup-git", "--hostname", "other.example"], ctx), 0);
  assert.equal(ctx.out.join(""), "git config --global credential.https://other.example.helper '!bb auth git-credential'\n");
  assert.equal(await main(["auth", "setup-git"], testContext()), 4);
});

const envTok = { BB_TOKEN: "tok", BB_HOST: HOST };

test("api GET prints JSON, honours -q, --jq and exit codes", async () => {
  const { fetch, requests } = fakeFetch(() => json(200, { values: [{ title: "A" }, { title: "B" }], size: 2 }));
  const ctx = testContext({ fetch, env: envTok });
  assert.equal(await main(["api", "/projects/KEY/repos/r/pull-requests", "-q", "state=OPEN", "-q", "limit=50"], ctx), 0);
  assert.equal(requests[0]!.url, `${CORE}/projects/KEY/repos/r/pull-requests?state=OPEN&limit=50`);
  assert.equal(requests[0]!.headers["authorization"], "Bearer tok");
  assert.deepEqual(JSON.parse(ctx.out.join("")), { values: [{ title: "A" }, { title: "B" }], size: 2 });

  ctx.out.length = 0;
  assert.equal(await main(["api", "projects", "--jq", ".values[].title"], ctx), 0);
  assert.equal(ctx.out.join(""), "A\nB\n");

  ctx.out.length = 0;
  assert.equal(await main(["api", "projects", "--jq", ".size"], ctx), 0);
  assert.equal(ctx.out.join(""), "2\n");
});

test("api --hostname picks the login for that host", async () => {
  const { fetch, requests } = fakeFetch(() => json(200, {}));
  const ctx = testContext({ fetch });
  writeHosts(join(ctx.configDir, "hosts.yml"), {
    [HOST]: { active: "alice", users: [{ account: "alice", accountId: null, gitUser: "alice", token: "t-one", expiresAt: null }] },
    "git.other.example": { active: "bob", users: [{ account: "bob", accountId: null, gitUser: "bob", token: "t-two", expiresAt: null }] },
  });
  assert.equal(await main(["api", "projects", "--hostname", "git.other.example"], ctx), 0);
  assert.equal(requests[0]!.url, "https://git.other.example/rest/api/latest/projects");
  assert.equal(requests[0]!.headers["authorization"], "Bearer t-two");
  assert.equal(await main(["api", "projects"], ctx), 4);
  assert.match(ctx.err.join(""), /several hosts/);
});

test("api {project}/{repo} placeholders need a Bitbucket remote", async () => {
  const ctx = testContext({ env: envTok });
  assert.equal(await main(["api", "projects/{project}/repos/{repo}"], ctx), 2);
  assert.match(ctx.err.join(""), /need a Bitbucket git remote/);
});

test("api builds nested JSON bodies from -f/-F and defaults to POST", async () => {
  const { fetch, requests } = fakeFetch(() => json(201, { id: 7 }));
  const ctx = testContext({ fetch, env: envTok });
  const code = await main(
    ["api", "projects/KEY/repos/r/pull-requests", "-f", "title=Fix it", "-f", "fromRef.id=refs/heads/fix", "-f", "toRef.id=refs/heads/main", "-F", "draft=true", "-F", "reviewers[]=x"],
    ctx,
  );
  assert.equal(code, 0);
  assert.equal(requests[0]!.method, "POST");
  assert.deepEqual(JSON.parse(requests[0]!.body!), {
    title: "Fix it",
    fromRef: { id: "refs/heads/fix" },
    toRef: { id: "refs/heads/main" },
    draft: true,
    reviewers: ["x"],
  });
});

test("api --input - reads JSON from stdin; -X overrides the method; --silent prints nothing", async () => {
  const { fetch, requests } = fakeFetch(() => json(200, { ok: true }));
  const ctx = testContext({ fetch, env: envTok, stdin: '{"text":"hi","version":0}' });
  assert.equal(await main(["api", "projects/KEY/repos/r/pull-requests/1/comments/9", "--input", "-", "-X", "PUT", "--silent"], ctx), 0);
  assert.equal(requests[0]!.method, "PUT");
  assert.equal(requests[0]!.body, '{"text":"hi","version":0}');
  assert.equal(ctx.out.join(""), "");
});

test("api --paginate concatenates pages", async () => {
  const { fetch } = fakeFetch((req) =>
    req.url.includes("start=2") ? json(200, { values: [{ id: 3 }], isLastPage: true }) : json(200, { values: [{ id: 1 }, { id: 2 }], isLastPage: false, nextPageStart: 2 }),
  );
  const ctx = testContext({ fetch, env: envTok });
  assert.equal(await main(["api", "projects", "--paginate", "--jq", ".[].id"], ctx), 0);
  assert.equal(ctx.out.join(""), "1\n2\n3\n");
});

test("api -i prints status and headers", async () => {
  const { fetch } = fakeFetch(() => json(200, { a: 1 }, { "x-arequestid": "@abc" }));
  const ctx = testContext({ fetch, env: envTok });
  assert.equal(await main(["api", "projects", "-i"], ctx), 0);
  const out = ctx.out.join("");
  assert.match(out, /^HTTP 200/);
  assert.match(out, /x-arequestid: @abc/);
  assert.match(out, /"a": 1/);
});

test("api maps errors to exit codes and messages", async () => {
  const { fetch } = fakeFetch(() => json(401, { errors: [{ message: "Authentication failed. Please check your credentials and try again." }] }));
  const ctx = testContext({ fetch, env: envTok });
  assert.equal(await main(["api", "projects"], ctx), 4);
  assert.match(ctx.err.join(""), /authentication failed \(401\).*Please check your credentials/);

  const rl = fakeFetch(() => json(429, {}, { "retry-after": "12" }));
  const ctx2 = testContext({ fetch: rl.fetch, env: envTok });
  assert.equal(await main(["api", "projects"], ctx2), 1);
  assert.match(ctx2.err.join(""), /rate limited \(429\), retry after 12s/);

  const ctx3 = testContext();
  assert.equal(await main(["api", "projects"], ctx3), 4);
  assert.match(ctx3.err.join(""), /no Bitbucket host/);
  const ctx3b = testContext({ env: { BB_HOST: HOST } });
  assert.equal(await main(["api", "projects"], ctx3b), 4);
  assert.match(ctx3b.err.join(""), /not logged in to bitbucket.example.com/);

  const ctx4 = testContext({ env: envTok });
  assert.equal(await main(["api", "projects", "-H", "Authorization: Bearer x"], ctx4), 2);
  assert.equal(await main(["api"], ctx4), 2);
  assert.equal(await main(["api", "projects", "--bogus"], ctx4), 2);
});

test("api --verbose logs requests without the token", async () => {
  const { fetch } = fakeFetch(() => json(200, {}));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "supersecret", BB_HOST: HOST } });
  assert.equal(await main(["api", "projects", "--verbose"], ctx), 0);
  assert.deepEqual(ctx.debugLines, [`> GET ${CORE}/projects`, "< 200 "]);
});

test("unexpected errors are redacted before reaching stderr", async () => {
  const { fetch } = fakeFetch(() => Promise.reject(new Error("socket hang up while sending Bearer supersecret to supersecret")));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "supersecret", BB_HOST: HOST } });
  assert.equal(await main(["api", "projects"], ctx), 1);
  assert.equal(ctx.err.join(""), "bb: socket hang up while sending Bearer *** to ***\n");
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
