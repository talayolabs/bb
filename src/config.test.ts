import { test } from "node:test";
import assert from "node:assert/strict";
import { baseUrl, configDir, NoHostError, normalizeHost, resolveHost } from "./config.ts";
import type { HostsFile } from "./hosts.ts";

const user = { account: "a", accountId: null, gitUser: "a", token: "t", expiresAt: null };
const one: HostsFile = { "bitbucket.example.com": { active: "a", users: [user] } };
const two: HostsFile = { ...one, "git.other.example": { active: "a", users: [user] } };

test("normalizeHost strips scheme, path, :443 and case; baseUrl is always https", () => {
  assert.equal(normalizeHost(" HTTPS://Bitbucket.Example.com:443/path/ "), "bitbucket.example.com");
  assert.equal(normalizeHost("http://host.example/"), "host.example");
  assert.equal(normalizeHost("host.example:8443"), "host.example:8443");
  assert.equal(baseUrl("Host.Example"), "https://host.example");
});

test("resolveHost: BB_HOST, then the current remote, then the only login", () => {
  assert.equal(resolveHost({ BB_HOST: "https://X.example" }, two, "y.example"), "x.example");
  assert.equal(resolveHost({}, two, "Y.example"), "y.example");
  assert.equal(resolveHost({}, one), "bitbucket.example.com");
  assert.equal(resolveHost({}, { ...one, empty: { active: null, users: [] } }), "bitbucket.example.com");
  assert.throws(() => resolveHost({}, two), (e: unknown) => e instanceof NoHostError && /several hosts/.test(e.message));
  assert.throws(() => resolveHost({}, {}), (e: unknown) => e instanceof NoHostError && /--hostname/.test(e.message));
});

test("configDir honours BB_CONFIG_DIR and XDG_CONFIG_HOME", () => {
  assert.equal(configDir({ BB_CONFIG_DIR: "/tmp/x" }), "/tmp/x");
  assert.equal(configDir({ XDG_CONFIG_HOME: "/tmp/xdg" }), "/tmp/xdg/bb");
  assert.match(configDir({}), /[\\/]\.config[\\/]bb$/);
});
