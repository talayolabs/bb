import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPath, parseRemote } from "./api.ts";

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

test("parseRemote understands https and ssh bitbucket.org remotes only", () => {
  assert.deepEqual(parseRemote("https://bitbucket.org/ws/repo.git"), { workspace: "ws", slug: "repo" });
  assert.deepEqual(parseRemote("https://alice@bitbucket.org/ws/repo"), { workspace: "ws", slug: "repo" });
  assert.deepEqual(parseRemote("git@bitbucket.org:ws/repo.git"), { workspace: "ws", slug: "repo" });
  assert.deepEqual(parseRemote("ssh://git@bitbucket.org/ws/repo.git"), { workspace: "ws", slug: "repo" });
  assert.equal(parseRemote("https://github.com/ws/repo.git"), null);
  assert.equal(parseRemote("https://bitbucket.org/ws"), null);
});
