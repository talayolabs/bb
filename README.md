# bb — Bitbucket Data Center from the command line

`bb` is to a self-hosted Bitbucket (Data Center / Server, e.g. `bitbucket.yourcompany.com`) what `gh`
is to GitHub: one login, then `git push`, pull-request commands and REST calls all work as that
account, with nothing to paste into git remotes or environment variables.

Status: **early**. Today `bb` does guided login, account management, a git credential helper,
`bb pr create | list | view | checks | comment | approve` and a generic `bb api` — see [Roadmap](#roadmap).

Requires Node.js 22.18+.

## Install

```sh
npm install -g @talayolabs/bb            # once published
# or, from a checkout:
npm ci && npm run build && npm link
# or a single file, e.g. for a container image:
npm run bundle && cp build/bb.mjs /usr/local/bin/bb
```

`bb` is also run by git (as a credential helper) from inside arbitrary repositories, so it must not
depend on a per-directory Node version. With asdf/mise/nvm either set a global default Node, or
install a wrapper that pins the interpreter:

```sh
printf '#!/bin/sh\nexec "%s" "%s/bb/build/bb.mjs" "$@"\n' "$(asdf which node)" "$HOME" > ~/.local/bin/bb
chmod +x ~/.local/bin/bb
```

## Log in

```sh
bb auth login --hostname bitbucket.yourcompany.com
```

`bb` opens `https://bitbucket.yourcompany.com/plugins/servlet/access-tokens/` in your browser
(Profile picture → Manage account → HTTP access tokens). Create a token — *Project: Read* plus
*Repository: Write* is enough to clone, push and do everything on pull requests except merging — and
paste it once into the terminal (input is hidden). `bb` verifies it, learns your username from the
instance and stores both in `hosts.yml` (mode 0600, under `$BB_CONFIG_DIR`, `$XDG_CONFIG_HOME/bb` or
`~/.config/bb`). Tokens can be given an expiry when created; `bb auth status` shows it and warns a week
ahead.

Non-interactive (CI, sandbox supervisors):

```sh
bb auth login --hostname bitbucket.yourcompany.com --with-token < token.txt
bb auth login --hostname bitbucket.yourcompany.com --with-token --skip-verify --user alice < token.txt
```

Several hosts and several accounts per host can be logged in; `--hostname <host>` or `BB_HOST` picks
the host (inside a clone of a Bitbucket repository the remote's host is used, and with a single login
there is nothing to pick). `bb auth switch --user <name>` picks the active account,
`bb auth logout [--user <name>]` removes one, `bb auth token` prints the active token for other tools.

`BB_TOKEN` (with `BB_HOST`, and `BB_GIT_USER` for git) overrides the stored login for one-off
commands and CI.

Behind a TLS-inspecting proxy or VPN (Cloudflare WARP, Zscaler, …) Node does not trust the proxy's
root CA even though your browser and `curl` do; `bb` then reports `could not verify the TLS certificate`.
Point Node at the CA once: `export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/cloudflare-gateway.pem` (WARP on Linux; find yours with `ls /etc/ssl/certs | grep -i cloudflare`)
(or `export NODE_OPTIONS=--use-system-ca` on Node 22.15+).

OAuth 2.0 login is deliberately not implemented: on Data Center it requires an administrator to create
an incoming application link per instance.

## Git over HTTPS

```sh
bb auth setup-git    # prints:
git config --global credential.https://bitbucket.yourcompany.com.helper '!bb auth git-credential'
git clone https://bitbucket.yourcompany.com/scm/PROJ/repo.git
```

The helper answers only for hosts in `hosts.yml` (or `BB_HOST`), with your real username and the HTTP
access token as the password, exactly as Bitbucket documents it. It accepts and ignores `store`/`erase`
so git never persists the token anywhere else, and stays silent for github.com or any other host.

## Pull requests

```sh
bb pr create                              # current branch → default branch, title/body from the last commit
bb pr create -t "Fix login" -b "Closes BOCATO-1" -B release/1.2 -r alice -r bob --draft --web
bb pr list --state ALL --author alice -L 10
bb pr view                                # the open pull request of the current branch
bb pr view 12 --comments                  # threads, replies, tasks, resolved markers, file:line anchors
bb pr checks 12                           # build statuses of the source commit (exit 1 if one failed)
bb pr comment 12 --body "Looks good"
bb pr comment 12 --reply-to 345 --body-file reply.md
bb pr approve 12 · bb pr request-changes 12 · bb pr unapprove 12
bb pr view https://bitbucket.yourcompany.com/projects/PROJ/repos/repo/pull-requests/12/overview
```

Pull requests are addressed by number, URL or (when omitted) the current branch; the repository comes
from the current remote or `--repo KEY/slug`. `--json` prints the raw API objects. `bb pr create`
refuses to open a pull request from a branch that has no upstream (push it first). There is no
`bb pr merge`: Bitbucket does not let HTTP access tokens merge (the merge commit needs an interactive
user) — `bb pr view --web` takes you there.

## REST API

```sh
bb api projects/{project}/repos/{repo}/pull-requests -q state=OPEN --paginate --jq '.[].title'
bb api projects/PROJ/repos/repo/pull-requests \
  -f title='Fix the thing' -f fromRef.id=refs/heads/fix -f toRef.id=refs/heads/main
bb api projects/PROJ/repos/repo/pull-requests/12/comments -f text='Looks good'
bb api projects/PROJ/repos/repo/pull-requests/12/activities --paginate
bb api rest/build-status/latest/commits/<sha>
bb api users/alice --hostname bitbucket.yourcompany.com
```

Paths are relative to `https://<host>/rest/api/latest`; paths starting with `rest/` are resolved at the
instance root (other REST modules such as `rest/build-status`, `rest/default-reviewers`). `{project}` and
`{repo}` are filled from the current directory's remote — `https://host/scm/KEY/slug.git`,
`ssh://git@host:7999/KEY/slug.git` and `https://host/projects/KEY/repos/slug` are understood.
`--paginate` follows `start`/`nextPageStart` until `isLastPage`. Requests use `Authorization: Bearer`,
absolute URLs must be on the same host (the token is never sent elsewhere), errors are classified
(401 → exit 4, 429 reports `Retry-After`) and the token is never printed, not even with `--verbose`.

Exit codes: `0` ok · `1` error · `2` usage · `4` no host / not logged in / token rejected.

## `hosts.yml`

```yaml
bitbucket.yourcompany.com:
    user: alice
    account_id: "101"
    git_user: alice
    oauth_token: <HTTP access token>
    expires_at: 2027-09-21T00:00:00Z     # optional
    users:
        alice:
            account_id: "101"
            git_user: alice
            oauth_token: <HTTP access token>
            expires_at: 2027-09-21T00:00:00Z
```

The layout mirrors `gh`'s so other programs can provision it (for example a sandbox supervisor that
writes a token to a tmpfs `BB_CONFIG_DIR`). `git_user` defaults to `user`; set it to `x-token-auth` for
project/repository tokens. The key stays `oauth_token` for `gh` compatibility even though the value is an
HTTP access token.

## Roadmap

- `bb pr` line comments, resolving threads and tasks, `bb pr diff`, `bb repo clone`.
- Bitbucket Cloud (bitbucket.org) as a second provider.

## Development

```sh
npm ci
npm test              # node:test, runs the .ts sources directly
npm run typecheck
npm run build         # dist/ (npm package)
npm run bundle        # build/bb.mjs (single file)
```

No runtime dependencies; `esbuild` and `typescript` are the only dev dependencies.

## License

MIT
