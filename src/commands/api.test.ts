import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPath, fillPlaceholders } from "./api.ts";
import { parseRemote } from "../remote.ts";

test("applyPath supports dot paths, [] iteration and indexes", () => {
  const doc = { values: [{ title: "A", n: 1 }, { title: "B", n: 2 }], meta: { size: 2 } };
  assert.equal(applyPath(doc, ".meta.size"), 2);
  assert.equal(applyPath(doc, "meta.size"), 2);
  assert.deepEqual(applyPath(doc, ".values[].title"), { __lines: ["A", "B"] });
  assert.deepEqual(applyPath(doc, ".values[1].n"), 2);
  assert.deepEqual(applyPath([1, 2], ".[]"), { __lines: [1, 2] });
  assert.equal(applyPath(doc, "."), doc);
  assert.equal(applyPath(doc, ".missing.deeper"), undefined);
});

test("parseRemote understands Data Center clone and browse URLs", () => {
  const want = { host: "bitbucket.example.com", project: "KEY", slug: "repo" };
  assert.deepEqual(parseRemote("https://bitbucket.example.com/scm/KEY/repo.git"), want);
  assert.deepEqual(parseRemote("https://alice@Bitbucket.Example.com:443/scm/KEY/repo"), want);
  assert.deepEqual(parseRemote("https://bitbucket.example.com/bitbucket/scm/KEY/repo.git"), want);
  assert.deepEqual(parseRemote("ssh://git@bitbucket.example.com:7999/KEY/repo.git"), want);
  assert.deepEqual(parseRemote("ssh://git@bitbucket.example.com/KEY/repo.git"), want);
  assert.deepEqual(parseRemote("https://bitbucket.example.com/projects/KEY/repos/repo"), want);
  assert.deepEqual(parseRemote("https://bitbucket.example.com/projects/KEY/repos/repo/browse"), want);
  assert.deepEqual(parseRemote("https://bitbucket.example.com/projects/KEY/repos/repo/pull-requests/12/overview"), want);
  assert.deepEqual(parseRemote("https://bitbucket.example.com/scm/~alice/repo.git"), { ...want, project: "~alice" });
});

test("parseRemote rejects GitHub, Bitbucket Cloud and malformed URLs", () => {
  assert.equal(parseRemote("https://github.com/ws/repo.git"), null);
  assert.equal(parseRemote("git@github.com:ws/repo.git"), null);
  assert.equal(parseRemote("git@bitbucket.example.com:KEY/repo.git"), null);
  assert.equal(parseRemote("https://bitbucket.org/ws/repo.git"), null);
  assert.equal(parseRemote("https://bitbucket.example.com/scm/KEY"), null);
  assert.equal(parseRemote("https://bitbucket.example.com/projects/KEY"), null);
});

test("fillPlaceholders substitutes {project} and {repo}", () => {
  const repo = { host: "h", project: "~alice", slug: "repo" };
  assert.equal(fillPlaceholders("projects/{project}/repos/{repo}/pull-requests", repo), "projects/~alice/repos/repo/pull-requests");
  assert.equal(fillPlaceholders("projects/X/repos/y", null), "projects/X/repos/y");
});
