# Releasing Baron

Two independent milestones: **(1) push the source to a public GitHub repo**, and later **(2) publish
the packages to npm** (so `npx @lonca/baron-mcp-server` and the Claude Code plugin work for others). You can
do (1) now; (2) only when you want others to install without cloning.

## 1. First public GitHub push

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

**Create the repo and push** (the repo currently has no remote):

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
- [x] **`@lonca/baron-conformance` is `private: true` for now** (marked in v0.1.0) — it's only ever a
      *devDependency* of the adapters/cli/mcp-server, so no published package needs it at runtime. To
      publish it later (so third parties can conformance-test their own adapters), split its entry
      points (pure in-memory transports vs. the vitest-coupled suites), add a `build`/`files`/
      `publishConfig`, drop `private`, then republish.
- [x] **Versioning:** packages are at **`0.1.0`** (set by `scripts/prep-publish.mjs`, which also applies
      per-package `repository`/`homepage`/`bugs`/`keywords`/`description`, `files: ["dist"]`, and copies
      `LICENSE`/`README` into each). For future releases, consider adopting
      [Changesets](https://github.com/changesets/changesets) to automate bumps + changelogs.

**Each release:**

```bash
# Bump the ten package.json versions first, then:
pnpm sync:server-json                 # reconciles server.json's two version fields and the package's mcpName
pnpm install && pnpm build            # publishConfig flips main/types/exports to dist; bins already point there
pnpm test && pnpm licenses:check      # never publish red

# Scoped packages default to RESTRICTED (private) — OSS must publish public.
pnpm -r --filter "./packages/**" publish --access public --no-git-checks
# (or `pnpm changeset publish` if using Changesets)
```

Notes:
- **`mcpName` must ship in the tarball.** The MCP Registry will not list a server whose npm package
  cannot be proven to belong to the same publisher; for npm the proof is `mcpName` in the *published*
  `package.json`, matching `server.json`'s `name`. `pnpm sync:server-json` keeps them equal and CI
  fails on drift (`pnpm sync:server-json --check`) — a mismatch is a rejected submission, not a stale
  number. v0.32.0 shipped without it, which is why 0.32.1 exists.
- pnpm publishes in **dependency order** and rewrites `workspace:*` deps to the real version — no manual
  ordering needed.
- Only the built `dist` + declared `files` ship; `src` is included per each package's `files` (kept so
  recipes/`import.meta.url` assets and source maps resolve). Tests, `scripts/`, and dev config never ship.
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

Consumers launching via `@latest` (the plugin manifest and the documented `.mcp.json` shape do) pick
up the new release on their next MCP restart automatically.

## 3. MCP Registry listing

The official registry (`registry.modelcontextprotocol.io`) is the surface several others mirror, so
it goes first and in the same week as a release — that ranking weights recency.

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_amd64.tar.gz" | tar xz   # ships mcp-publisher.exe on Windows
mcp-publisher login github --token "$(gh auth token)"   # see below — plain `login github` will NOT do
mcp-publisher publish                                   # reads ./server.json from the cwd
```

> **The org namespace needs a `read:org` token, and `mcp-publisher login github` does not mint one.**
> The registry grants `io.github.<org>/*` only after calling `GET /user/memberships/orgs`, which
> requires the `read:org` scope. A token without it gets a 403 that the registry **deliberately
> swallows** as "no admin orgs" so personal publishing keeps working — so the device flow succeeds,
> reports nothing wrong, and silently leaves you with `io.github.keparlak/*` only. The 403 from
> `publish` then blames private org membership, which is about an older code path and is *not* the
> gate. Passing a token that carries `read:org` (the `gh` CLI's does) is what actually works. This
> cost three rounds of browser sign-in on the first submission.

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

`punkpeye/awesome-mcp-servers` takes a PR, but its bot labels any entry lacking a Glama score badge,
and that badge 404s until Glama has indexed the repo — so it waits on the claim above. PulseMCP needs
no submission at all: it ingests the official registry.

## Commercial tier (later)

Enterprise features live in a **separate private repo** under a commercial license (e.g. Elastic
License v2), depend on the published `@lonca/baron-*` packages, and publish to a **private** registry — never
mixed into this repo. Only build the entitlement machinery once there is a paying design-partner
(ARCHITECTURE.md #20).
