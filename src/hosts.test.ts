import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeUser, parseHosts, readHosts, removeUser, renderHosts, updateUser, upsertUser, writeHosts, type HostsFile } from "./hosts.ts";

const sample: HostsFile = {
  "bitbucket.example.com": {
    active: "jperelli",
    users: [
      {
        account: "jperelli",
        accountId: "{7c3d0000-0000-4000-8000-000000000000}",
        gitUser: "jperelli",
        token: "access-1",
        expiresAt: "2026-09-21T19:03:00Z",
      },
      { account: "bot", accountId: null, gitUser: "x-token-auth", token: "MDM0MjM5NDc2MDabc", expiresAt: null },
    ],
  },
};

test("renders the gh-like layout with the active user duplicated at the top", () => {
  const text = renderHosts(sample);
  assert.equal(
    text,
    [
      "bitbucket.example.com:",
      "    user: jperelli",
      '    account_id: "{7c3d0000-0000-4000-8000-000000000000}"',
      "    git_user: jperelli",
      "    oauth_token: access-1",
      "    expires_at: 2026-09-21T19:03:00Z",
      "    users:",
      "        jperelli:",
      '            account_id: "{7c3d0000-0000-4000-8000-000000000000}"',
      "            git_user: jperelli",
      "            oauth_token: access-1",
      "            expires_at: 2026-09-21T19:03:00Z",
      "        bot:",
      "            git_user: x-token-auth",
      "            oauth_token: MDM0MjM5NDc2MDabc",
      "",
    ].join("\n"),
  );
});

test("parse(render(x)) round-trips", () => {
  assert.deepEqual(parseHosts(renderHosts(sample)), sample);
});

test("parses a Daemon-style file with only top-level scalars", () => {
  const hosts = parseHosts("bitbucket.example.com:\n    user: alice\n    git_user: x-token-auth\n    oauth_token: t1\n");
  assert.deepEqual(hosts["bitbucket.example.com"], {
    active: "alice",
    users: [{ account: "alice", accountId: null, gitUser: "x-token-auth", token: "t1", expiresAt: null }],
  });
});

test("git_user defaults to the account name", () => {
  const hosts = parseHosts("bitbucket.example.com:\n    user: alice\n    oauth_token: t1\n");
  assert.equal(hosts["bitbucket.example.com"]!.users[0]!.gitUser, "alice");
});

test("tolerates comments, blank lines, CRLF, quoted keys and an unknown active user", () => {
  const text = [
    "# written by hand",
    '"bitbucket.example.com":',
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
  const entry = parseHosts(text)["bitbucket.example.com"]!;
  assert.equal(entry.active, "alice");
  assert.equal(entry.users[0]!.token, "it's");
  assert.equal(entry.users[1]!.token, "t2");
});

test("quotes values that YAML would otherwise mistype", () => {
  const text = renderHosts({
    h: { active: "true", users: [{ account: "true", accountId: "123", gitUser: "x", token: "a b", expiresAt: null }] },
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
  const carol = { account: "carol", accountId: null, gitUser: "x-token-auth", token: "t3", expiresAt: null };
  let hosts = upsertUser(sample, "bitbucket.example.com", carol);
  assert.equal(activeUser(hosts, "bitbucket.example.com")!.account, "carol");
  assert.equal(hosts["bitbucket.example.com"]!.users.length, 3);

  hosts = updateUser(hosts, "bitbucket.example.com", { ...sample["bitbucket.example.com"]!.users[0]!, token: "access-2" });
  assert.equal(activeUser(hosts, "bitbucket.example.com")!.account, "carol");
  assert.equal(hosts["bitbucket.example.com"]!.users.find((u) => u.account === "jperelli")!.token, "access-2");

  hosts = removeUser(hosts, "bitbucket.example.com", "carol");
  assert.equal(activeUser(hosts, "bitbucket.example.com")!.account, "jperelli");
  hosts = removeUser(removeUser(hosts, "bitbucket.example.com", "jperelli"), "bitbucket.example.com", "bot");
  assert.deepEqual(hosts, {});
});

test("readHosts on a missing file is empty, and the written file contains no tmp leftovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-hosts-"));
  assert.deepEqual(readHosts(join(dir, "nope.yml")), {});
  writeHosts(join(dir, "hosts.yml"), sample);
  assert.equal(readFileSync(join(dir, "hosts.yml"), "utf8"), renderHosts(sample));
});
