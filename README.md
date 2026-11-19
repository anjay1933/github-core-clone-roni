# RoniForge — a GitHub-compatible git forge in one Node process

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/anjay1933/github-core-clone-roni/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/anjay1933/github-core-clone-roni/reward.svg)](https://make.fun/bounty/github-core-clone-01)

An entry for [github-core-clone-01 on make.fun](https://make.fun/bounty/github-core-clone-01):
build a GitHub-compatible git forge — smart HTTP (clone/push), REST v3, GraphQL v4 and MCP —
as a single Node 22 process with no dependencies and no `git` binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to install:
the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until `{"done":true}`, then exit 0.

## Design — one hash-addressed object store, four views

Everything lives in a single content-addressed store (`store.ts`): git objects keyed by
SHA-1, plus repo records (refs, labels, issues, pull requests). REST, GraphQL, MCP and the
git wire protocol are four views over the same records, so a commit pushed over smart HTTP
is immediately visible through the API, and a merge made over REST is immediately clonable.

- `gitpack.ts` — object hashing, pkt-line framing, packfiles (plain objects, no deltas),
  tree/commit/tag parsing and building, reachability.
- `store.ts` — the object store and repo records; trees, merges (three-way, squash),
  contents as commits; fixed identity and timestamps so two runs are byte-identical.
- `githttp.ts` — smart HTTP: `info/refs` (protocol v2 and v0), `git-upload-pack`
  (v2 fetch with sections, shallow/deepen, unshallow; v0 fetch), `git-receive-pack`
  (v0 push with report-status over sideband band 1).
- `rest.ts` — GitHub REST v3: repositories, branches, commits, refs, contents, labels,
  issues, comments, pull requests, files, merges; pagination via `Link: rel="next"`.
- `graphql.ts` — a small GraphQL executor for the documents `gh` and
  `github-mcp-server` send: `viewer`, `repository`, `node`, issue/pull-request
  connections, the five mutations, and `__type` introspection. Global ids are opaque
  base64url strings, never plain database ids.
- `mcp.ts` — Model Context Protocol, modern revision `2026-07-28` (`server/discover`,
  no handshake) with the legacy `2025-11-25` initialize path: six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`).
- `app.ts` — routing, bearer-token auth, `X-GitHub-Request-Id` on every reply.

## Local check

The kit's runner grades the same suite the trial runs:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf]
```

Local result: **120/120 conformance checks, 15/15 MCP checks, perf 177/200**
(push 41, clone 44, read 47, write 45) — expected total 977/1000.

## License

MIT — see [LICENSE](LICENSE).
