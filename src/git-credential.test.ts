import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { handleGitCredential, parseGitCredentialInput } from "./git-credential.ts";
import { readHosts, writeHosts } from "./hosts.ts";
import { fakeFetch, json, testContext } from "./test-helpers.ts";

const get = "protocol=https\nhost=bitbucket.org\n";

function loggedIn(opts: { expiresAt?: string | null; refreshToken?: string | null; token?: string } = {}) {
  const ctx = testContext();
  writeHosts(join(ctx.configDir, "hosts.yml"), {
    "bitbucket.org": {
      active: "alice",
      users: [
        {
          account: "alice",
          accountId: null,
          gitUser: "x-token-auth",
          token: opts.token ?? "access-1",
          expiresAt: opts.expiresAt ?? null,
          refreshToken: opts.refreshToken ?? null,
        },
      ],
    },
  });
  return ctx;
}

test("parses key=value lines including values containing '='", () => {
  assert.deepEqual(parseGitCredentialInput("protocol=https\nhost=bitbucket.org\npath=a=b\n\n"), {
    protocol: "https",
    host: "bitbucket.org",
    path: "a=b",
  });
});

test("get answers for https://bitbucket.org with the stored login", async () => {
  const ctx = loggedIn();
  const r = await handleGitCredential("get", get, { env: ctx.env });
  assert.deepEqual(r, { stdout: "username=x-token-auth\npassword=access-1\n", exitCode: 0 });
});

test("get stays silent for other hosts and for http", async () => {
  const ctx = loggedIn();
  for (const input of ["protocol=https\nhost=github.com\n", "protocol=http\nhost=bitbucket.org\n", "protocol=https\nhost=api.bitbucket.org\n"]) {
    assert.deepEqual(await handleGitCredential("get", input, { env: ctx.env }), { stdout: "", exitCode: 0 });
  }
});

test("get accepts host with :443 and mixed case", async () => {
  const ctx = loggedIn();
  const r = await handleGitCredential("get", "protocol=https\nhost=BitBucket.org:443\n", { env: ctx.env });
  assert.equal(r.stdout, "username=x-token-auth\npassword=access-1\n");
});

test("store and erase are no-ops; unknown ops fail", async () => {
  const ctx = loggedIn();
  assert.deepEqual(await handleGitCredential("store", get + "username=x\npassword=y\n", { env: ctx.env }), { stdout: "", exitCode: 0 });
  assert.deepEqual(await handleGitCredential("erase", get, { env: ctx.env }), { stdout: "", exitCode: 0 });
  assert.equal((await handleGitCredential("frobnicate", get, { env: ctx.env })).exitCode, 1);
});

test("BB_TOKEN overrides hosts.yml and picks the git user from the token shape", async () => {
  const ctx = loggedIn();
  const oauth = await handleGitCredential("get", get, { env: { ...ctx.env, BB_TOKEN: "abc123" } });
  assert.equal(oauth.stdout, "username=x-token-auth\npassword=abc123\n");
  const api = await handleGitCredential("get", get, { env: { ...ctx.env, BB_TOKEN: "ATATT3xFfGF0zzz" } });
  assert.equal(api.stdout, "username=x-bitbucket-api-token-auth\npassword=ATATT3xFfGF0zzz\n");
  const custom = await handleGitCredential("get", get, { env: { ...ctx.env, BB_TOKEN: "abc", BB_GIT_USER: "someone" } });
  assert.equal(custom.stdout, "username=someone\npassword=abc\n");
});

test("a username git already knows is honoured only when it is ours", async () => {
  const ctx = loggedIn();
  assert.equal((await handleGitCredential("get", get + "username=x-token-auth\n", { env: ctx.env })).stdout.length > 0, true);
  assert.equal((await handleGitCredential("get", get + "username=alice\n", { env: ctx.env })).stdout.length > 0, true);
  assert.deepEqual(await handleGitCredential("get", get + "username=someone-else\n", { env: ctx.env }), { stdout: "", exitCode: 0 });
});

test("not logged in: exit 0, nothing on stdout, hint on stderr", async () => {
  const ctx = testContext();
  const r = await handleGitCredential("get", get, { env: ctx.env });
  assert.equal(r.stdout, "");
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr ?? "", /not logged in/);
});

test("an expired token without refresh is reported, an unexpired one is served", async () => {
  const now = () => new Date("2026-09-21T12:00:00Z");
  const expired = loggedIn({ expiresAt: "2026-09-21T11:00:00Z" });
  const r = await handleGitCredential("get", get, { env: expired.env, now });
  assert.equal(r.stdout, "");
  assert.match(r.stderr ?? "", /expired at 2026-09-21T11:00:00Z/);
  const soon = loggedIn({ expiresAt: "2026-09-21T12:02:00Z" });
  assert.equal((await handleGitCredential("get", get, { env: soon.env, now })).stdout, "username=x-token-auth\npassword=access-1\n");
});

test("an expiring token with a refresh token is refreshed and the rotation persisted", async () => {
  const ctx = loggedIn({ expiresAt: "2026-09-21T12:02:00Z", refreshToken: "refresh-1" });
  const { fetch, requests } = fakeFetch(() => json(200, { access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 }));
  const env = { ...ctx.env, BB_OAUTH_CLIENT_ID: "key", BB_OAUTH_CLIENT_SECRET: "secret" };
  const now = () => new Date("2026-09-21T12:00:00Z");
  const r = await handleGitCredential("get", get, { env, fetch, now });
  assert.equal(r.stdout, "username=x-token-auth\npassword=access-2\n");

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://bitbucket.org/site/oauth2/access_token");
  assert.equal(requests[0]!.headers["authorization"], `Basic ${Buffer.from("key:secret").toString("base64")}`);
  assert.equal(requests[0]!.body, "grant_type=refresh_token&refresh_token=refresh-1");

  const again = await handleGitCredential("get", get, { env, fetch, now });
  assert.equal(again.stdout, "username=x-token-auth\npassword=access-2\n");
  assert.equal(requests.length, 1, "second call uses the persisted token");
  const u = readHosts(join(ctx.configDir, "hosts.yml"))["bitbucket.org"]!.users[0]!;
  assert.equal(u.refreshToken, "refresh-2");
  assert.equal(u.expiresAt, "2026-09-21T14:00:00Z");
});
