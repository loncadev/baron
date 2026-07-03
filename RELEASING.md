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
pnpm install && pnpm build            # publishConfig flips main/types/exports to dist; bins already point there
pnpm test && pnpm licenses:check      # never publish red

# Scoped packages default to RESTRICTED (private) — OSS must publish public.
pnpm -r --filter "./packages/**" publish --access public --no-git-checks
# (or `pnpm changeset publish` if using Changesets)
```

Notes:
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
npx -y @lonca/baron-mcp-server@latest     # should start the MCP server (Ctrl-C to stop)
npx -y @lonca/baron-cli@latest --help     # should print the CLI usage
```

Consumers launching via `@latest` (the plugin manifest and the documented `.mcp.json` shape do) pick
up the new release on their next MCP restart automatically.

## Commercial tier (later)

Enterprise features live in a **separate private repo** under a commercial license (e.g. Elastic
License v2), depend on the published `@lonca/baron-*` packages, and publish to a **private** registry — never
mixed into this repo. Only build the entitlement machinery once there is a paying design-partner
(ARCHITECTURE.md #20).
