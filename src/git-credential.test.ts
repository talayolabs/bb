import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { handleGitCredential, parseGitCredentialInput } from "./git-credential.ts";
import { writeHosts } from "./hosts.ts";
import { testContext } from "./test-helpers.ts";

const HOST = "bitbucket.example.com";
const get = `protocol=https\nhost=${HOST}\n`;

function loggedIn(opts: { expiresAt?: string | null; token?: string; gitUser?: string } = {}) {
  const ctx = testContext();
  writeHosts(join(ctx.configDir, "hosts.yml"), {
    [HOST]: {
      active: "alice",
      users: [{ account: "alice", accountId: "101", gitUser: opts.gitUser ?? "alice", token: opts.token ?? "access-1", expiresAt: opts.expiresAt ?? null }],
    },
  });
  return ctx;
}

test("parses key=value lines including values containing '='", () => {
  assert.deepEqual(parseGitCredentialInput(`protocol=https\nhost=${HOST}\npath=a=b\n\n`), {
    protocol: "https",
    host: HOST,
    path: "a=b",
  });
});

test("get answers for a logged-in host with the real username and the token", async () => {
  const ctx = loggedIn();
  const r = await handleGitCredential("get", get, { env: ctx.env });
  assert.deepEqual(r, { stdout: "username=alice\npassword=access-1\n", exitCode: 0 });
});

test("get stays silent for other hosts, for http, and when nothing is logged in", async () => {
  const ctx = loggedIn();
  for (const input of ["protocol=https\nhost=github.com\n", `protocol=http\nhost=${HOST}\n`, "protocol=https\nhost=bitbucket.org\n", `protocol=https\nhost=other.${HOST}\n`]) {
    assert.deepEqual(await handleGitCredential("get", input, { env: ctx.env }), { stdout: "", exitCode: 0 });
  }
  assert.deepEqual(await handleGitCredential("get", get, { env: testContext().env }), { stdout: "", exitCode: 0 });
});

test("get accepts host with :443 and mixed case", async () => {
  const ctx = loggedIn();
  const r = await handleGitCredential("get", "protocol=https\nhost=BitBucket.Example.com:443\n", { env: ctx.env });
  assert.equal(r.stdout, "username=alice\npassword=access-1\n");
});

test("store and erase are no-ops; unknown ops fail", async () => {
  const ctx = loggedIn();
  assert.deepEqual(await handleGitCredential("store", get + "username=x\npassword=y\n", { env: ctx.env }), { stdout: "", exitCode: 0 });
  assert.deepEqual(await handleGitCredential("erase", get, { env: ctx.env }), { stdout: "", exitCode: 0 });
  assert.equal((await handleGitCredential("frobnicate", get, { env: ctx.env })).exitCode, 1);
});

test("BB_TOKEN answers only for BB_HOST, as BB_GIT_USER or x-token-auth", async () => {
  const ctx = loggedIn();
  const env = { ...ctx.env, BB_TOKEN: "abc123", BB_HOST: HOST };
  assert.equal((await handleGitCredential("get", get, { env })).stdout, "username=x-token-auth\npassword=abc123\n");
  assert.equal((await handleGitCredential("get", get, { env: { ...env, BB_GIT_USER: "someone" } })).stdout, "username=someone\npassword=abc123\n");
  assert.deepEqual(await handleGitCredential("get", "protocol=https\nhost=elsewhere.example.com\n", { env }), { stdout: "", exitCode: 0 });
  // Without BB_HOST there is no way to know which host the token belongs to.
  assert.deepEqual(await handleGitCredential("get", get, { env: { ...ctx.env, BB_TOKEN: "abc123" } }), { stdout: "", exitCode: 0 });
});

test("a username git already knows is honoured only when it is ours", async () => {
  const ctx = loggedIn({ gitUser: "x-token-auth" });
  assert.equal((await handleGitCredential("get", get + "username=x-token-auth\n", { env: ctx.env })).stdout.length > 0, true);
  assert.equal((await handleGitCredential("get", get + "username=alice\n", { env: ctx.env })).stdout.length > 0, true);
  assert.deepEqual(await handleGitCredential("get", get + "username=someone-else\n", { env: ctx.env }), { stdout: "", exitCode: 0 });
});

test("a host entry without a token: exit 0, nothing on stdout, hint on stderr", async () => {
  const ctx = testContext();
  writeHosts(join(ctx.configDir, "hosts.yml"), { [HOST]: { active: "alice", users: [{ account: "alice", accountId: null, gitUser: "alice", token: "", expiresAt: null }] } });
  const r = await handleGitCredential("get", get, { env: ctx.env });
  assert.equal(r.stdout, "");
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr ?? "", /not logged in/);
});

test("an expired token is reported, an unexpired one is served", async () => {
  const now = () => new Date("2026-09-21T12:00:00Z");
  const expired = loggedIn({ expiresAt: "2026-09-21T11:00:00Z" });
  const r = await handleGitCredential("get", get, { env: expired.env, now });
  assert.equal(r.stdout, "");
  assert.match(r.stderr ?? "", /expired at 2026-09-21T11:00:00Z/);
  assert.ok(!(r.stderr ?? "").includes("access-1"));
  const soon = loggedIn({ expiresAt: "2026-09-21T12:02:00Z" });
  assert.equal((await handleGitCredential("get", get, { env: soon.env, now })).stdout, "username=alice\npassword=access-1\n");
});
