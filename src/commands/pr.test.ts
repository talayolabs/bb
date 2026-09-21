import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.ts";
import { writeHosts } from "../hosts.ts";
import { parsePrUrl } from "../remote.ts";
import { fakeFetch, json, testContext, type FakeRequest, type TestContextOptions } from "../test-helpers.ts";

const HOST = "bitbucket.example.com";
const CORE = `https://${HOST}/rest/api/latest`;
const REPO = `${CORE}/projects/KEY/repos/app`;

const alice = { name: "alice", displayName: "Alice Smith", slug: "alice" };
const bob = { name: "bob", displayName: "Bob Jones", slug: "bob" };

function pr(over: Record<string, unknown> = {}) {
  return {
    id: 12,
    version: 3,
    title: "Fix login",
    description: "Closes BOCATO-1",
    state: "OPEN",
    open: true,
    closed: false,
    draft: false,
    createdDate: 1758400000000,
    author: { user: alice, role: "AUTHOR", approved: false, status: "UNAPPROVED" },
    reviewers: [{ user: bob, role: "REVIEWER", approved: true, status: "APPROVED" }],
    fromRef: { id: "refs/heads/fix-login", displayId: "fix-login", latestCommit: "abcdef0123456789abcdef0123456789abcdef01", repository: { slug: "app", project: { key: "KEY" } } },
    toRef: { id: "refs/heads/main", displayId: "main", latestCommit: "1111111111111111111111111111111111111111", repository: { slug: "app", project: { key: "KEY" } } },
    links: { self: [{ href: `https://${HOST}/projects/KEY/repos/app/pull-requests/12` }] },
    ...over,
  };
}

/** A git checkout of KEY/app with `fix-login` checked out and pushed to a bare "origin". */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-pr-"));
  const bare = join(root, "origin.git");
  const work = join(root, "app");
  const run = (args: string[], cwd = work) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  run(["init", "--bare", "-q", "-b", "main", bare], root);
  run(["init", "-q", "-b", "main", work], root);
  writeFileSync(join(work, "a.txt"), "a\n");
  run(["add", "a.txt"]);
  run(["commit", "-q", "-m", "init"]);
  run(["remote", "add", "origin", bare]);
  run(["push", "-q", "-u", "origin", "main"]);
  run(["checkout", "-q", "-b", "fix-login"]);
  writeFileSync(join(work, "a.txt"), "b\n");
  run(["commit", "-q", "-am", "Fix login\n\nCloses BOCATO-1\n"]);
  run(["push", "-q", "-u", "origin", "fix-login"]);
  // The bare origin is local; the Bitbucket remote is what bb reads to find the repository.
  run(["remote", "set-url", "origin", `https://${HOST}/scm/KEY/app.git`]);
  run(["remote", "add", "local", bare]);
  return work;
}

/** Context whose git commands run inside `cwd` and that is logged in to the fake host. */
function prContext(cwd: string, opts: TestContextOptions = {}): ReturnType<typeof testContext> {
  const ctx = testContext({ ...opts, env: { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd, ...opts.env } });
  writeHosts(join(ctx.configDir, "hosts.yml"), {
    [HOST]: { active: "alice", users: [{ account: "alice", accountId: "1", gitUser: "alice", token: "tok", expiresAt: null }] },
  });
  return ctx;
}

function dc(handler: (req: FakeRequest, url: URL) => Response | undefined) {
  return fakeFetch((req) => {
    if (req.headers["authorization"] !== "Bearer tok") return json(401, { errors: [{ message: "nope" }] });
    return handler(req, new URL(req.url)) ?? json(404, { errors: [{ message: `no route for ${req.method} ${req.url}` }] });
  });
}

test("parsePrUrl accepts Data Center pull request URLs only", () => {
  assert.deepEqual(parsePrUrl(`https://${HOST}/projects/KEY/repos/app/pull-requests/12/overview`), { host: HOST, project: "KEY", slug: "app", id: 12 });
  assert.deepEqual(parsePrUrl(`https://${HOST}/bitbucket/projects/KEY/repos/app/pull-requests/7`), { host: HOST, project: "KEY", slug: "app", id: 7 });
  assert.deepEqual(parsePrUrl(`https://${HOST}/projects/KEY/repos/app/pull-requests/7/diff#a.txt`)?.id, 7);
  assert.equal(parsePrUrl("https://github.com/o/r/pull/12"), null);
  assert.equal(parsePrUrl(`https://${HOST}/projects/KEY/repos/app`), null);
});

test("pr create uses the current branch, the default branch and the last commit, then prints the URL", async () => {
  const cwd = checkout();
  const { fetch, requests } = dc((req, url) => {
    if (url.pathname.endsWith("/default-branch")) return json(200, { id: "refs/heads/main", displayId: "main", type: "BRANCH" });
    if (req.method === "POST" && url.pathname.endsWith("/pull-requests")) return json(201, pr({ id: 42 }));
    return undefined;
  });
  const ctx = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "create", "--reviewer", "bob", "--draft"], ctx), 0);
  assert.equal(ctx.out.join(""), `https://${HOST}/projects/KEY/repos/app/pull-requests/42/overview\n`);
  assert.equal(requests[0]!.url, `${REPO}/default-branch`);
  assert.deepEqual(JSON.parse(requests[1]!.body!), {
    title: "Fix login",
    description: "Closes BOCATO-1",
    draft: true,
    fromRef: { id: "refs/heads/fix-login", repository: { slug: "app", project: { key: "KEY" } } },
    toRef: { id: "refs/heads/main", repository: { slug: "app", project: { key: "KEY" } } },
    reviewers: [{ user: { name: "bob" } }],
  });
});

test("pr create honours --title/--body/--base/--head and --web; refuses an unpushed branch", async () => {
  const cwd = checkout();
  const { fetch, requests } = dc((req, url) => (req.method === "POST" && url.pathname.endsWith("/pull-requests") ? json(201, pr({ id: 43 })) : undefined));
  const ctx = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "create", "-t", "T", "-b", "B", "-B", "release", "-H", "topic", "--web"], ctx), 0);
  const body = JSON.parse(requests[0]!.body!) as { title: string; description: string; fromRef: { id: string }; toRef: { id: string }; draft?: boolean };
  assert.equal(body.title, "T");
  assert.equal(body.description, "B");
  assert.equal(body.fromRef.id, "refs/heads/topic");
  assert.equal(body.toRef.id, "refs/heads/release");
  assert.equal(body.draft, undefined);
  assert.deepEqual(ctx.opened, [`https://${HOST}/projects/KEY/repos/app/pull-requests/43/overview`]);

  execFileSync("git", ["checkout", "-q", "-b", "unpushed"], { cwd });
  const ctx2 = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "create", "-t", "T"], ctx2), 2);
  assert.match(ctx2.err.join(""), /branch "unpushed" has not been pushed; run `git push -u origin unpushed`/);
});

test("pr list prints a table, filters by state/author/base and stops at --limit", async () => {
  const cwd = checkout();
  const { fetch, requests } = dc((req, url) => {
    if (url.pathname.endsWith("/pull-requests")) {
      const start = Number(url.searchParams.get("start") ?? "0");
      if (start === 0) return json(200, { values: [pr(), pr({ id: 11, title: "Older", state: "MERGED" })], isLastPage: false, nextPageStart: 2 });
      return json(200, { values: [pr({ id: 10, title: "Oldest", draft: true })], isLastPage: true });
    }
    return undefined;
  });
  const ctx = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "list", "--state", "all", "--author", "alice", "--base", "main"], ctx), 0);
  const q = new URL(requests[0]!.url).searchParams;
  assert.equal(q.get("state"), "ALL");
  assert.equal(q.get("username.1"), "alice");
  assert.equal(q.get("role.1"), "AUTHOR");
  assert.equal(q.get("at"), "refs/heads/main");
  assert.equal(ctx.out.join(""), "#12  Fix login  alice  fix-login → main  OPEN\n#11  Older      alice  fix-login → main  MERGED\n#10  Oldest     alice  fix-login → main  DRAFT\n");

  const ctx2 = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "list", "-L", "1", "--json"], ctx2), 0);
  assert.equal((JSON.parse(ctx2.out.join("")) as unknown[]).length, 1);
  assert.equal(await main(["pr", "list", "--state", "weird"], prContext(cwd, { fetch })), 2);
});

test("pr view resolves the current branch, a number or a URL; --comments renders threads", async () => {
  const cwd = checkout();
  const { fetch, requests } = dc((req, url) => {
    if (url.pathname.endsWith("/pull-requests")) {
      assert.equal(url.searchParams.get("at"), "refs/heads/fix-login");
      assert.equal(url.searchParams.get("direction"), "OUTGOING");
      return json(200, { values: [pr()], isLastPage: true });
    }
    if (url.pathname.endsWith("/pull-requests/12")) return json(200, pr());
    if (url.pathname.endsWith("/pull-requests/12/activities")) {
      return json(200, {
        isLastPage: true,
        values: [
          { id: 3, action: "APPROVED", user: bob, createdDate: 1758400300000 },
          {
            id: 2,
            action: "COMMENTED",
            commentAction: "ADDED",
            createdDate: 1758400200000,
            commentAnchor: { path: "a.txt", line: 1, lineType: "ADDED" },
            comment: { id: 201, text: "Typo here", author: bob, createdDate: 1758400200000, severity: "BLOCKER", state: "OPEN", comments: [{ id: 202, text: "Fixed", author: alice, createdDate: 1758400250000, comments: [] }] },
          },
          { id: 1, action: "COMMENTED", commentAction: "ADDED", createdDate: 1758400100000, comment: { id: 200, text: "Nice work\nreally", author: bob, createdDate: 1758400100000, threadResolved: true, comments: [] } },
          { id: 0, action: "OPENED", user: alice, createdDate: 1758400000000 },
        ],
      });
    }
    return undefined;
  });
  const ctx = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "view"], ctx), 0);
  assert.equal(
    ctx.out.join(""),
    [
      "Fix login #12",
      "OPEN · Alice Smith wants to merge fix-login into main",
      "Reviewers: bob (approved)",
      "",
      "Closes BOCATO-1",
      "",
      `https://${HOST}/projects/KEY/repos/app/pull-requests/12/overview`,
      "",
    ].join("\n"),
  );

  const ctx2 = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "view", "12", "--comments"], ctx2), 0);
  assert.equal(requests.at(-2)!.url, `${REPO}/pull-requests/12`);
  const out = ctx2.out.join("");
  assert.match(out, /2 comment threads:\n\n\[200\] Bob Jones · 2025-09-20 \d\d:\d\d · resolved\n  Nice work\n  really\n\n\[201\] Bob Jones · [\d -:]+ · task, a\.txt:1\n  Typo here\n  \[202\] Alice Smith · [\d -:]+\n    Fixed\n/);

  const ctx3 = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "view", `https://${HOST}/projects/KEY/repos/app/pull-requests/12/diff`, "--json"], ctx3), 0);
  assert.equal((JSON.parse(ctx3.out.join("")) as { id: number }).id, 12);

  const ctx4 = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "view", "12", "--web"], ctx4), 0);
  assert.deepEqual(ctx4.opened, [`https://${HOST}/projects/KEY/repos/app/pull-requests/12/overview`]);
  assert.equal(await main(["pr", "view", "twelve"], prContext(cwd, { fetch })), 2);
});

test("pr view outside a Bitbucket checkout needs --repo, and a URL works anywhere", async () => {
  const { fetch } = dc((req, url) => (url.pathname.endsWith("/pull-requests/12") ? json(200, pr()) : undefined));
  const ctx = testContext({ fetch, env: { BB_TOKEN: "tok", BB_HOST: HOST } });
  assert.equal(await main(["pr", "view", "12"], ctx), 2);
  assert.match(ctx.err.join(""), /not in a Bitbucket repository; pass --repo KEY\/slug/);

  const ctx2 = testContext({ fetch, env: { BB_TOKEN: "tok", BB_HOST: HOST } });
  assert.equal(await main(["pr", "view", "12", "--repo", "KEY/app"], ctx2), 0);
  assert.match(ctx2.out.join(""), /^Fix login #12\n/);

  const ctx3 = testContext({ fetch, env: { BB_TOKEN: "tok" } });
  assert.equal(await main(["pr", "view", `https://${HOST}/projects/KEY/repos/app/pull-requests/12`], ctx3), 0);
});

test("pr checks lists build statuses of the source commit and fails on FAILED", async () => {
  const cwd = checkout();
  const builds = [
    { key: "ci", name: "CI", state: "SUCCESSFUL", url: "https://ci.example.com/1" },
    { key: "lint", state: "FAILED", url: "https://ci.example.com/2" },
  ];
  const { fetch, requests } = dc((req, url) => {
    if (url.pathname.endsWith("/pull-requests/12")) return json(200, pr());
    if (url.pathname === "/rest/build-status/latest/commits/abcdef0123456789abcdef0123456789abcdef01") return json(200, { values: builds, isLastPage: true });
    return undefined;
  });
  const ctx = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "checks", "12"], ctx), 1);
  assert.equal(requests[1]!.url, `https://${HOST}/rest/build-status/latest/commits/abcdef0123456789abcdef0123456789abcdef01`);
  assert.equal(ctx.out.join(""), "✓  CI    SUCCESSFUL  https://ci.example.com/1\n✗  lint  FAILED      https://ci.example.com/2\n");

  builds.pop();
  const ctx2 = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "checks", "12", "--json"], ctx2), 0);
  assert.deepEqual(JSON.parse(ctx2.out.join("")), builds);
});

test("pr comment posts a general comment or a reply", async () => {
  const cwd = checkout();
  const { fetch, requests } = dc((req, url) => {
    if (url.pathname.endsWith("/pull-requests/12")) return json(200, pr());
    if (req.method === "POST" && url.pathname.endsWith("/pull-requests/12/comments")) return json(201, { id: 300, text: JSON.parse(req.body!).text });
    return undefined;
  });
  const ctx = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "comment", "12", "--body", "Looks good"], ctx), 0);
  assert.deepEqual(JSON.parse(requests[1]!.body!), { text: "Looks good" });
  assert.equal(ctx.out.join(""), `https://${HOST}/projects/KEY/repos/app/pull-requests/12/overview?commentId=300\n`);

  const ctx2 = prContext(cwd, { fetch, stdin: "Done\n" });
  assert.equal(await main(["pr", "comment", "12", "--body-file", "-", "--reply-to", "201"], ctx2), 0);
  assert.deepEqual(JSON.parse(requests[3]!.body!), { text: "Done", parent: { id: 201 } });

  const ctx3 = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "comment", "12"], ctx3), 2);
  assert.match(ctx3.err.join(""), /--body <text> or --body-file <file> is required/);
});

test("pr approve / request-changes / unapprove set the participant status for the logged-in user", async () => {
  const cwd = checkout();
  const { fetch, requests } = dc((req, url) => {
    if (url.pathname.endsWith("/pull-requests/12")) return json(200, pr());
    if (req.method === "PUT" && url.pathname.endsWith("/pull-requests/12/participants/alice")) return json(200, { user: alice, status: JSON.parse(req.body!).status });
    return undefined;
  });
  const ctx = prContext(cwd, { fetch });
  assert.equal(await main(["pr", "approve", "12"], ctx), 0);
  assert.deepEqual(JSON.parse(requests[1]!.body!), { status: "APPROVED" });
  assert.equal(ctx.out.join(""), "✓ Approved pull request #12 (Fix login)\n");
  assert.equal(await main(["pr", "request-changes", "12"], prContext(cwd, { fetch })), 0);
  assert.deepEqual(JSON.parse(requests[3]!.body!), { status: "NEEDS_WORK" });
  assert.equal(await main(["pr", "unapprove", "12"], prContext(cwd, { fetch })), 0);
  assert.deepEqual(JSON.parse(requests[5]!.body!), { status: "UNAPPROVED" });
});

test("pr approve with BB_TOKEN discovers the user through X-AUSERNAME", async () => {
  const me = { id: 7, name: "Carol", slug: "carol", displayName: "Carol" };
  const { fetch, requests } = dc((req, url) => {
    if (url.pathname.endsWith("/pull-requests/12")) return json(200, pr());
    if (url.pathname.endsWith("/inbox/pull-requests/count")) return json(200, { count: 0 }, { "x-ausername": "Carol" });
    if (url.pathname.endsWith("/users/Carol")) return json(200, me);
    if (req.method === "PUT" && url.pathname.endsWith("/participants/carol")) return json(200, { user: me, status: "APPROVED" });
    return undefined;
  });
  const ctx = testContext({ fetch, env: { BB_TOKEN: "tok", BB_HOST: HOST } });
  assert.equal(await main(["pr", "approve", "12", "-R", "KEY/app"], ctx), 0);
  assert.equal(requests.at(-1)!.url, `${REPO}/pull-requests/12/participants/carol`);
});

test("pr help and unknown subcommands", async () => {
  const ctx = testContext();
  assert.equal(await main(["pr"], ctx), 2);
  assert.match(ctx.out.join(""), /bb pr <command>/);
  assert.equal(await main(["pr", "--help"], ctx), 0);
  assert.equal(await main(["pr", "create", "--help"], ctx), 0);
  assert.equal(await main(["help", "pr"], ctx), 0);
  assert.equal(await main(["pr", "merge", "12"], ctx), 2);
  assert.match(ctx.err.join(""), /unknown pr command "merge"/);
});
