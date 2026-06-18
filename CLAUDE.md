# Baron — Project Rules

Baron is a **platform-agnostic work-orchestration layer for AI coding agents**. It lets an agent
(or a CI pipeline) drive work tracking, source control, and notifications across many providers
through one normalized contract, instead of hardwiring a single vendor's API and one team's
process template into prompts.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) first — it is the single source of truth for the
foundational decisions. This file is the day-to-day working contract.

## Tech stack

- TypeScript (NodeNext, strict), ESM only. Node >= 20.
- pnpm workspaces monorepo.
- vitest (tests), biome (lint + format), tsup (build for publish).

## Local development

```
pnpm install
pnpm test          # vitest run (all packages)
pnpm typecheck     # tsc --noEmit per package
pnpm lint          # biome check
pnpm lint:fix      # biome check --write
```

Workspace packages resolve to **source** (`src/index.ts`) in dev — no build step needed to run
tests or typecheck. `publishConfig` in each package.json flips `main`/`types`/`exports` to `dist`
for release; `pnpm build` (tsup) produces it. Do not point dev consumers at `dist`.

## Architecture invariants (do not violate without revisiting ARCHITECTURE.md)

1. **Capability ports, not "a tracker."** Work is organized into independent ports — `issues`,
   `scm`, `notify`, `docs` — each bound to a provider independently. A consumer mixes providers
   (Linear issues + GitHub PRs + Slack notify). Never assume one provider spans all ports.
2. **Semantic role layer.** Recipes and primitives speak abstract roles
   (`backlog → ready → in_progress → in_review → done`, plus `blocked`). Providers map their
   native states/columns/labels onto roles via config (`baron init` introspects + a human
   confirms). Never hardcode a provider-native state in core or recipe logic.
3. **Primitives in core, workflows in recipes.** The core exposes primitives only
   (`issue.create`, `issue.transition`, ...). Workflow *opinion* (when to move to `in_review`,
   PR body shape, hierarchy rules) lives in declarative YAML recipes outside the core. Do not bake
   workflow opinion into the core or into an adapter.
4. **Adapters carry no translation logic.** An adapter contributes only a `CapabilityManifest` and
   an `IssuesTransport` (provider I/O). All role↔native translation and gap negotiation live in the
   shared `BaseIssuesAdapter`. If you find yourself writing role/state mapping inside an adapter,
   it belongs in core.
5. **Capability gaps are never silent.** When an operation needs a capability the provider lacks,
   behavior is decided by explicit policy: `error` (loud, actionable), `emulate:<strategy>`
   (synthesize, e.g. GitHub hierarchy via labels), or `degrade` (skip + `warn` log). A gap that is
   neither errored nor logged is a bug.

## Conventions

- **No magic strings for domain concepts.** Provider ids, role names, type-role names, capability
  names, gap behaviors, status/mode identifiers — all centralized (constants / unions in core, or
  the relevant adapter's exported constants). No raw literals in comparisons or branching.
- **Language.** All code, identifiers, committed artifacts, and default user-facing output are in
  **English**. User-facing output is configurable per installation (`language.interaction` vs
  `language.artifacts`); never hardcode a non-English string into a primitive or recipe.
- **Secrets are never committed.** `policy.json` (committed) holds policy only; credentials live in
  env / a secret-manager hook / `.baron/credentials` (gitignored). Never log tokens.
- **Comments explain WHY, not WHAT.** Well-named identifiers document behavior; reserve comments
  for non-obvious constraints, lossy trade-offs, or deferred follow-ups.

## Testing

- Every adapter must pass the shared **conformance suite** (`@baron/conformance`) using the
  in-memory transport — pure, network-free, deterministic.
- Live provider behavior is validated by **gated smoke tests** (skipped unless the relevant
  credentials are present in env). Never commit credentials or recordings containing secrets.
- A change that widens the capability or port contract must extend the conformance suite in the
  same change.

## License

Open-core. The core, P0 adapters (Azure DevOps, GitHub, Slack), recipes, and CLI/MCP server are
Apache-2.0. Commercial-tier features (SSO, secret-manager integrations, multi-team governance,
audit) ship under a separate license and must not be mixed into the OSS packages.
