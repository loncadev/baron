# Releasing Baron

Both milestones below are **done** — the repo is public at `github.com/loncadev/baron` and the
packages are on npm. Section 1 is kept as the record of what the first push required; the live
procedure starts at [section 2](#2-npm-publish).

## 1. First public GitHub push — done

**Pre-flight (safety + hygiene):**

- [ ] **No secrets tracked.** `git ls-files | grep -iE 'credential|token|secret|\.env|\.pem'` returns
      only source/examples (`credentials.ts`, `credentials.example` with empty placeholders) — never a
      real token. `.baron/credentials` is gitignored.
- [ ] **LICENSE + NOTICE present.** `LICENSE` is the verbatim Apache-2.0 text; `NOTICE` states the
      open-core scope. GitHub will detect the repo as Apache-2.0.
- [ ] **CONTRIBUTING.md** in place (DCO sign-off + relicensing grant). Have the CLA reviewed by
      counsel before accepting outside PRs at scale.
- [ ] **Trademark** — run a clearance search on the product name before promoting it; the name, not
      the (permissive) code, is the defensible mark. See [ARCHITECTURE.md](./ARCHITECTURE.md) #20.
- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm licenses:check`
      all green (this is exactly what CI runs).

**Create the repo and push** — how it was done, for the record:

```bash
gh repo create baron --public --source=. --remote=origin --description "Platform-agnostic work-orchestration for AI coding agents"
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs on the first push. The Claude Code plugin can then be installed
from the public repo (`claude --plugin-dir ./plugins/claude-code`), still launching a local build
until step 2 is done.

## 2. npm publish

**One-time:**

- [x] **Scope: `@lonca/baron-*`** (published 2026-07-02). The `@baron` org was taken; packages live
      under the owned `@lonca` org, prefixed `baron-` because plain `@lonca/*` names (e.g.
      `@lonca/core`) already exist.
- [x] **Auth (the hard-won lesson):** the account has 2FA `auth-and-writes`, so publishing needs a
      **granular access token with the "Bypass two-factor authentication" checkbox CHECKED**
      (classic/Automation tokens were removed by npm in Dec 2025; write tokens are capped at 90 days —
      current one expires ~2026-09-30, regenerate then). Pitfall: `npm login` writes its own 2-hour
      *session token* into `~/.npmrc`, silently shadowing yours — if publish fails with `EOTP`, check
      that the `_authToken` line in `~/.npmrc` is the bypass token, not the session token.

      > **This token type is being withdrawn — see [#62](https://github.com/loncadev/baron/issues/62).**
      > Since **early August 2026** a bypass-2FA token can no longer perform account or package
      > *management*, which includes **minting its own replacement**: when the current one expires
      > around 2026-09-30, create the new one interactively with 2FA on the npm site, not from the
      > expiring token. Around **January 2027** these tokens lose direct publish entirely — the
      > release process moves to trusted publishing (OIDC from CI) or staged publishing with a human
      > approval. Publishing still works today; v0.32.0 shipped this way.
- [x] **`@lonca/baron-conformance` is `private: true`** — it's only ever a
      *devDependency* of the adapters/cli/mcp-server, so no published package needs it at runtime. To
      publish it later (so third parties can conformance-test their own adapters), split its entry
      points (pure in-memory transports vs. the vitest-coupled suites), add a `build`/`files`/
      `publishConfig`, drop `private`, then republish.
- [x] **Versioning:** every package shares one version, set by `scripts/bump-version.mjs` (the
      packages on disk are the list — no count is written down) and held there by a test, so a
      straggler cannot quietly republish an old version or pin a dependency to the release before.
      It is read by `scripts/prep-publish.mjs` from
      `packages/mcp-server/package.json` rather than restated (it also applies
      per-package `repository`/`homepage`/`bugs`/`keywords`/`description`, `files: ["dist"]`, and copies
      `LICENSE`/`README` into each). For future releases, consider adopting
      [Changesets](https://github.com/changesets/changesets) to automate bumps + changelogs.

**Each release:**

```bash
node scripts/bump-version.mjs 0.34.0   # sets every workspace package to one version
pnpm sync:server-json                 # reconciles server.json's two version fields and the package's mcpName
pnpm install && pnpm build            # publishConfig flips main/types/exports to dist; bins already point there
pnpm test && pnpm licenses:check      # never publish red

# Scoped packages default to RESTRICTED (private) — OSS must publish public.
pnpm -r --filter "./packages/**" publish --access public --no-git-checks
# (or `pnpm changeset publish` if using Changesets)

# Tag it, and say so publicly. Skipping this is invisible until you need it.
git tag -a "v$VERSION" -m "v$VERSION" && git push origin "v$VERSION"
gh release create "v$VERSION" --title "v$VERSION — <what changed>" --notes "..."
```

Notes:
- **Tagging is a step, not an afterthought.** It was forgotten for 0.32.0, 0.32.1 and 0.33.0 —
  three consecutive releases with no git ref — and nothing noticed, because nothing asks for it.
  The cost is not cosmetic: `git log v0.32.1..HEAD` returns empty, so there is no way to diff a
  release against the one before it, and that is exactly when you want one. Publishing the GitHub
  release matters for a different reason: without it the repository's own Releases page keeps
  advertising whatever version was last released there — it said `v0.1.0` for six weeks and
  thirty-two versions, on the page a stranger arriving from the MCP Registry lands on.
- **`mcpName` must ship in the tarball.** The MCP Registry will not list a server whose npm package
  cannot be proven to belong to the same publisher; for npm the proof is `mcpName` in the *published*
  `package.json`, matching `server.json`'s `name`. `pnpm sync:server-json` keeps them equal and CI
  fails on drift (`pnpm sync:server-json --check`) — a mismatch is a rejected submission, not a stale
  number. v0.32.0 shipped without it, which is why 0.32.1 exists.
- pnpm publishes in **dependency order** and rewrites `workspace:*` deps to the real version — no manual
  ordering needed.
- Only what each package's `files` declares ships — `["dist"]` everywhere except
  `@lonca/baron-recipes`, which adds `recipes` so the built-in YAML resolves by name at runtime.
  Tests, `src`, `scripts/`, and dev config never ship.
- `@lonca/baron-mcp-server` exposes bin `baron-mcp`; `@lonca/baron-cli` exposes bin `baron`. Both target `dist/bin.js`,
  so `pnpm build` must run first.

**After publishing, smoke-test the consumer path** (always with an explicit `@latest` or version —
a bare package name makes `npx` reuse its cached install without re-checking the registry, so you'd
be smoke-testing a stale version):

```bash
node scripts/mcp-handshake.mjs npx -y @lonca/baron-mcp-server@latest   # speaks the protocol to it
npx -y @lonca/baron-cli@latest --help                                  # should print the CLI usage
```

The handshake script is worth using over a bare `npx`: a server that starts and then fails to answer
looks identical to a working one from the terminal, and the failure that matters — anything on stdout
that is not JSON-RPC — is invisible until a client chokes on it. It runs `initialize` + `tools/list`
and prints the version and tool count, so a stale cache or a broken publish shows up as the wrong
number rather than as silence.

**To try the bits that would ship before publishing them**, build a self-contained tree the way the
Dockerfile does — `pnpm --filter @lonca/baron-cli deploy --prod --legacy <dir>` then
`node scripts/apply-publish-config.mjs <dir>` — and run `node <dir>/dist/bin.js`. Do it from a
**throwaway copy of the repository, not the working tree**: under pnpm 11, `deploy` rewrites the
workspace packages' own `package.json` files to their `publishConfig` (main/types/exports flipped to
`dist`) and leaves them that way, so the next `pnpm test` runs against stale built output and
`git status` shows nine modified manifests. The Dockerfile is unaffected because it deploys from a
copy.

Consumers launching via `@latest` (the plugin manifest and the documented `.mcp.json` shape do) pick
up the new release on their next MCP restart automatically.

## 3. MCP Registry listing

The official registry (`registry.modelcontextprotocol.io`) is the surface several others mirror, so
it goes first and in the same week as a release — that ranking weights recency.

```bash
# The tarball carries LICENSE and README.md alongside the binary, so it is unpacked OUTSIDE the
# repository and only the one member is taken. Extracting it here replaces Baron's licence and
# front page in the working tree, silently, one step before the release someone `git add -A`s.
mkdir -p ../.mcp-publisher && curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_amd64.tar.gz" | tar xz -C ../.mcp-publisher mcp-publisher.exe
alias mcp-publisher=../.mcp-publisher/mcp-publisher.exe
mcp-publisher login github --token "$(gh auth token)"   # see below — plain `login github` will NOT do
mcp-publisher publish                                   # reads ./server.json from the cwd
```

> **Try plain `mcp-publisher login github` first — the `--token` above is a workaround for a bug
> that upstream is fixing.** If publishing still reports `You have permission to publish:
> io.github.<your-username>/*`, the workaround is still needed.
>
> The cause, per [modelcontextprotocol/registry#1468][reg-1468]: since registry v1.8.0 only
> organisation *Owners* may publish under an organisation namespace, and that is checked with
> `GET /user/memberships/orgs`, which requires the `read:org` scope — a scope the GitHub App token
> minted by `mcp-publisher login github` does not carry. The registry **deliberately swallows** the
> resulting 403 as "no admin orgs" so personal publishing keeps working, so the device flow succeeds,
> reports nothing wrong, and silently leaves you with your personal namespace. A maintainer confirmed
> this on 2026-07-27 and a proper fix is in progress.
>
> Two traps worth knowing before you spend an afternoon on it, as v0.32.1 did. The 403 blames private
> organisation membership; that belongs to an older code path and is **not** the gate — making a
> membership public is a visible change to a personal profile made for no reason. And the binary
> version matters: a user on that thread reports the workaround failing on `1.8.0` (built
> 2026-07-13), while ours succeeded on `1.8.1` (built 2026-08-06).

[reg-1468]: https://github.com/modelcontextprotocol/registry/issues/1468

Two further conditions, both real: whoever publishes must be an **Owner** of `loncadev` (membership
`role: admin`, `state: active` — an unaccepted invitation does not count), and the publish must come
**after** the npm release, because the registry fetches the referenced npm version and compares its
`mcpName` against `server.json`'s `name`. A freshly published npm version can 404 for a moment; the
registry says so explicitly, so retry once before suspecting the marker.

## 4. Discovery surfaces

The official registry (step 3) is the one that feeds the others, so it goes first and the rest can
follow at any pace. Two need a human at a browser and cannot be scripted:

- **Glama** — `glama.ai/mcp/servers` → *Add Server* (a JS button; there is no deep-link form URL).
  Baron appears there anyway, ingested from the official registry, but unclaimed. Claiming is what
  buys control of the display metadata and build spec. Because `loncadev` is an organisation rather
  than a personal account, signing in with GitHub is not enough on its own: the root `glama.json`
  names the maintainer, and the claim flow must be **re-run** after that file lands. Glama builds
  every open-source server in a sandbox — the committed `Dockerfile` keeps us off the inferred-build
  path, whose failure withholds the listing from search and category results.
- **Claude Code plugin marketplace** — `platform.claude.com/plugins/submit`. Not required to ship:
  `/plugin marketplace add loncadev/baron` already works from the committed
  `.claude-plugin/marketplace.json`. Never open a PR against `anthropics/claude-plugins-community`;
  it closes them automatically and syncs from an internal pipeline instead.
- **Docker MCP Catalog** — a PR against `docker/mcp-registry` adding `servers/baron/server.yaml`
  (no `tools.json`: the image starts on its baked-in policy, so Docker lists the tools itself and
  a nightly bot re-pins `source.commit` to `main` from then on). Docker builds, signs and hosts the
  image as `mcp/baron`; nothing here publishes one. The entry's `config.env` block enumerates every
  credential variable Baron reads (`credentialEnvKeys` in `packages/providers/src/index.ts`) — a new
  provider means a follow-up PR there, or its credentials cannot be entered in Docker Desktop. Before
  submitting or updating the entry, run the container the way Docker's lister does:
  `docker run --rm -i --init --cap-drop=ALL` with every `config.env` example and secret placeholder
  set, and check it answers `tools/list`; CI's `container` job covers the plain launch only.

`punkpeye/awesome-mcp-servers` takes a PR, but its bot labels any entry lacking a Glama score badge,
and that badge 404s until Glama has indexed the repo — so it waits on the claim above. PulseMCP needs
no submission at all: it ingests the official registry.

## Commercial tier (later)

Enterprise features live in a **separate private repo** under a commercial license (e.g. Elastic
License v2), depend on the published `@lonca/baron-*` packages, and publish to a **private** registry — never
mixed into this repo. Only build the entitlement machinery once there is a paying design-partner
(ARCHITECTURE.md #20).
