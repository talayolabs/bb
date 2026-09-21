# bb — Bitbucket Cloud from the command line

`bb` is to [bitbucket.org](https://bitbucket.org) what `gh` is to GitHub: one login, then `git push`,
REST calls and (soon) pull-request commands all work as that account, with nothing to paste into
git remotes or environment variables.

Status: **early**. Today `bb` does token login, account management, a git credential helper and a
generic `bb api`. Browser (OAuth) login and `bb pr …` are next — see [Roadmap](#roadmap).

Requires Node.js 22.18+.

## Install

```sh
npm install -g @talayolabs/bb            # once published
# or, from a checkout:
npm ci && npm run build && npm link
# or a single file, e.g. for a container image:
npm run bundle && cp build/bb.mjs /usr/local/bin/bb
```

## Log in

Create an [Atlassian API token with scopes](https://id.atlassian.com/manage-profile/security/api-tokens)
(`read:user:bitbucket`, `read:repository:bitbucket`, `write:repository:bitbucket`,
`read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`), then:

```sh
bb auth login --with-token < token.txt
bb auth status
```

`bb` verifies the token against `GET /2.0/user`, stores it in `hosts.yml` (mode 0600, under
`$BB_CONFIG_DIR`, `$XDG_CONFIG_HOME/bb` or `~/.config/bb`) and picks the git username the token needs
(`x-bitbucket-api-token-auth` for API tokens, `x-token-auth` for OAuth access tokens).

Several accounts can be logged in; `bb auth switch --user <name>` picks the active one and
`bb auth logout [--user <name>]` removes one. `bb auth token` prints the active access token for other tools.

`BB_TOKEN` (and optionally `BB_GIT_USER`) override the stored login for one-off commands and CI.

## Git over HTTPS

```sh
git config --global credential.https://bitbucket.org.helper '!bb auth git-credential'   # or: bb auth setup-git
git clone https://bitbucket.org/<workspace>/<repo>.git
```

The helper answers only for `https://bitbucket.org`, accepts and ignores `store`/`erase` so git never
persists the token elsewhere, and refreshes OAuth tokens transparently when it can.

## REST API

```sh
bb api user
bb api /repositories/{workspace}/{repo}/pullrequests -q state=OPEN --paginate --jq '.[].title'
bb api /repositories/ws/repo/pullrequests \
  -f title='Fix the thing' -f source.branch.name=fix -f destination.branch.name=main
bb api /repositories/ws/repo/pullrequests/12/comments -f content.raw='Looks good'
bb api /repositories/ws/repo/pullrequests/12/comments/99/resolve -X POST
```

Paths are relative to `https://api.bitbucket.org/2.0`; `{workspace}` and `{repo}` are filled from the
current directory's bitbucket.org remote. `--paginate` follows `next` links. Errors are classified
(401 → exit 4, 429 reports `Retry-After`) and the token is never printed, not even with `--verbose`.

Exit codes: `0` ok · `1` error · `2` usage · `4` not logged in / token rejected.

## `hosts.yml`

```yaml
bitbucket.org:
    user: jperelli
    account_id: "557058:…"
    git_user: x-token-auth
    oauth_token: <access token>
    expires_at: 2026-09-21T19:03:00Z
    refresh_token: <refresh token>     # only when bb obtained the token itself
    users:
        jperelli:
            account_id: "557058:…"
            git_user: x-token-auth
            oauth_token: <access token>
            expires_at: 2026-09-21T19:03:00Z
            refresh_token: <refresh token>
```

The layout mirrors `gh`'s so other programs can provision it (for example a sandbox supervisor that
writes short-lived access tokens to a tmpfs `BB_CONFIG_DIR` and keeps the refresh token to itself).
`expires_at` is optional; when present and a `refresh_token` plus an OAuth consumer
(`BB_OAUTH_CLIENT_ID`/`BB_OAUTH_CLIENT_SECRET`, or the embedded one) are available, `bb` refreshes
the token about five minutes before expiry and writes the rotated pair back.

## Roadmap

- `bb auth login` in the browser: embedded OAuth consumer, loopback callback, refresh-token rotation.
- `bb pr create | list | view | checks | comment | reply | resolve | reopen`, `bb repo clone`.
- Bitbucket Data Center is out of scope for now (different REST API and auth).

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
