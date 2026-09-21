import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeUser, parseHosts, readHosts, removeUser, renderHosts, updateUser, upsertUser, writeHosts, type HostsFile } from "./hosts.ts";

const sample: HostsFile = {
  "bitbucket.org": {
    active: "jperelli",
    users: [
      {
        account: "jperelli",
        accountId: "{7c3d0000-0000-4000-8000-000000000000}",
        gitUser: "x-token-auth",
        token: "access-1",
        expiresAt: "2026-09-21T19:03:00Z",
        refreshToken: "refresh-1",
      },
      { account: "bot", accountId: null, gitUser: "x-bitbucket-api-token-auth", token: "ATATT3xFfGF0abc", expiresAt: null, refreshToken: null },
    ],
  },
};

test("renders the gh-like layout with the active user duplicated at the top", () => {
  const text = renderHosts(sample);
  assert.equal(
    text,
    [
      "bitbucket.org:",
      "    user: jperelli",
      '    account_id: "{7c3d0000-0000-4000-8000-000000000000}"',
      "    git_user: x-token-auth",
      "    oauth_token: access-1",
      "    expires_at: 2026-09-21T19:03:00Z",
      "    refresh_token: refresh-1",
      "    users:",
      "        jperelli:",
      '            account_id: "{7c3d0000-0000-4000-8000-000000000000}"',
      "            git_user: x-token-auth",
      "            oauth_token: access-1",
      "            expires_at: 2026-09-21T19:03:00Z",
      "            refresh_token: refresh-1",
      "        bot:",
      "            git_user: x-bitbucket-api-token-auth",
      "            oauth_token: ATATT3xFfGF0abc",
      "",
    ].join("\n"),
  );
});

test("parse(render(x)) round-trips", () => {
  assert.deepEqual(parseHosts(renderHosts(sample)), sample);
});

test("parses a Daemon-style file with only top-level scalars", () => {
  const hosts = parseHosts("bitbucket.org:\n    user: alice\n    git_user: x-token-auth\n    oauth_token: t1\n");
  assert.deepEqual(hosts["bitbucket.org"], {
    active: "alice",
    users: [{ account: "alice", accountId: null, gitUser: "x-token-auth", token: "t1", expiresAt: null, refreshToken: null }],
  });
});

test("tolerates comments, blank lines, CRLF, quoted keys and an unknown active user", () => {
  const text = [
    "# written by hand",
    '"bitbucket.org":',
    "    user: nobody",
    "",
    "    users:",
    "        alice:",
    "            oauth_token: 'it''s'",
    "            git_user: x-token-auth\r",
    "        bob:",
    '            oauth_token: "t2"',
    "",
  ].join("\n");
  const entry = parseHosts(text)["bitbucket.org"]!;
  assert.equal(entry.active, "alice");
  assert.equal(entry.users[0]!.token, "it's");
  assert.equal(entry.users[1]!.token, "t2");
});

test("quotes values that YAML would otherwise mistype", () => {
  const text = renderHosts({
    h: { active: "true", users: [{ account: "true", accountId: "123", gitUser: "x", token: "a b", expiresAt: null, refreshToken: null }] },
  });
  assert.match(text, /^    user: "true"$/m);
  assert.match(text, /^    account_id: "123"$/m);
  assert.match(text, /^    oauth_token: "a b"$/m);
  assert.deepEqual(parseHosts(text).h!.users[0]!.token, "a b");
});

test("writeHosts creates dir 0700 / file 0600 atomically and removes the file when empty", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "bb-hosts-")), "cfg");
  const file = join(dir, "hosts.yml");
  writeHosts(file, sample);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readHosts(file), sample);
  assert.ok(!existsSync(`${file}.${process.pid}.tmp`));
  writeHosts(file, {});
  assert.ok(!existsSync(file));
  assert.deepEqual(readHosts(file), {});
});

test("upsert/update/remove keep the active pointer sensible", () => {
  const carol = { account: "carol", accountId: null, gitUser: "x-token-auth", token: "t3", expiresAt: null, refreshToken: null };
  let hosts = upsertUser(sample, "bitbucket.org", carol);
  assert.equal(activeUser(hosts, "bitbucket.org")!.account, "carol");
  assert.equal(hosts["bitbucket.org"]!.users.length, 3);

  hosts = updateUser(hosts, "bitbucket.org", { ...sample["bitbucket.org"]!.users[0]!, token: "access-2" });
  assert.equal(activeUser(hosts, "bitbucket.org")!.account, "carol");
  assert.equal(hosts["bitbucket.org"]!.users.find((u) => u.account === "jperelli")!.token, "access-2");

  hosts = removeUser(hosts, "bitbucket.org", "carol");
  assert.equal(activeUser(hosts, "bitbucket.org")!.account, "jperelli");
  hosts = removeUser(removeUser(hosts, "bitbucket.org", "jperelli"), "bitbucket.org", "bot");
  assert.deepEqual(hosts, {});
});

test("readHosts on a missing file is empty, and the written file contains no tmp leftovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-hosts-"));
  assert.deepEqual(readHosts(join(dir, "nope.yml")), {});
  writeHosts(join(dir, "hosts.yml"), sample);
  assert.equal(readFileSync(join(dir, "hosts.yml"), "utf8"), renderHosts(sample));
});
