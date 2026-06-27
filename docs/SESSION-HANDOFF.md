# Session handoff

This repo was bootstrapped in a session that ran from the Beetegre V2 repository (the original
`.claude` Azure DevOps toolkit was the seed material). Work now continues from this repo. A Claude
Code session is bound to its working directory, so the conversation itself does not move — this
note plus [ARCHITECTURE.md](../ARCHITECTURE.md) and [CLAUDE.md](../CLAUDE.md) carry the context.

## Where we are

The foundation, the **first vertical slice**, the **config engine**, and the **live SDK
transports + introspectors** are committed and green:

- `pnpm test` → 78/78 pass (+4 gated smoke skipped) · `pnpm typecheck` → clean (5 packages) ·
  `pnpm lint` → clean.
- Slice scope: the `issues` port across **Azure DevOps** (rich: native hierarchy, state+column)
  and **GitHub** (flat: no hierarchy, binary states), to stress the impedance bet at its hardest.
- Proven: the same primitives (`issue.create`, `issue.transition`) produce correct-but-different
  behavior per provider; capability gaps are handled explicitly (`error` / `emulate` / `degrade`)
  and never silently.
- Config engine done (`baron init` + `baron doctor`): a committed `.baron/policy.json` is parsed,
  validated, and resolved into the issues config; introspection + a manifest-aware proposal draft a
  role/type/gap map for human confirmation; `doctor` reports drift against the live provider.
- Live transports + introspectors wired: GitHub via octokit, Azure via azure-devops-node-api. Both
  read `NativeTarget` keys verbatim (no role logic in the adapter, invariant #4); validated by
  typecheck + an adversarial multi-agent review + credential-gated smoke (not run without creds).

## What exists

- `@baron/core` — roles, capability manifest, gap policy, `RoleResolver`, `IssuesPort` +
  `BaseIssuesAdapter` (all translation logic lives here).
- `@baron/adapter-azure-devops`, `@baron/adapter-github` — manifest + example role/type maps +
  `define*IssuesAdapter` factory + **live** transport & introspector (octokit / azure-devops-node-api)
  + a gated smoke test each.
- `@baron/conformance` — in-memory transport + in-memory introspector + the shared issues and
  introspection suites both adapters pass.
- `@baron/cli` — `baron init` / `baron doctor`. Pure command logic (`runInit` / `runDoctor`) behind
  injected `FileSystem` / `Prompter` / `Introspector` ports (tested with in-memory fakes); thin
  Node-backed shell in `bin.ts`; a provider registry + dependency-free flag parser.
- Core config-engine surface: `parsePolicy` / `serializePolicy` / `resolveIssuesConfig`
  (`policy-file.ts`); `Introspector` contract (`introspection.ts`); `proposePolicy` and friends
  (`proposal.ts`) — all impedance/translation logic, kept in core per invariant #4.

## Known debt (tracked, intentional)

- `LICENSE` holds an Apache-2.0 summary + URL; vendor the full canonical text before any public
  release.
- Live transports/introspectors have **never run against a real provider** here (no credentials).
  They are validated by typecheck, an adversarial review, and the in-memory conformance suite; the
  gated smoke tests are the first thing to run once real creds exist (set `GITHUB_OWNER/REPO/TOKEN`
  or `AZURE_DEVOPS_ORG/PROJECT/TOKEN`).
- GitHub cold `getIssue` cannot recover a mid-workflow role from labels (the transport must not hold
  the role map, invariant #4); role resolves on the write path (echo) and reads back as open/closed
  only. Same accepted shape of debt as reverse type-role resolution.
- Azure board-column writes go through the per-board hidden `WEF_<guid>_Kanban.Column` field
  discovered at runtime; multi-board projects can expose several such fields and picking the right
  one is ambiguous — provider-quirky, only meaningful to verify under live smoke.
- Reverse type-role resolution is lossy on providers that collapse all type roles to one native
  type (GitHub → `issue`). Faithful round-trip needs label emulation (same pattern as hierarchy).
- The proposal heuristics (board-column / type keyword matching) are English-biased and best-effort
  by design — every guess is recorded in `proposal.notes` for the human to confirm in `baron init`.

## Agreed next step

The config engine and the live transports/introspectors are done. Remaining queued options — not
yet chosen; decide at the start of the next session:

- **MCP server skeleton.** Expose the issues primitives over stdio MCP, reading the real
  `policy.json` via `resolveIssuesConfig` and binding the live transport from the provider registry.
  This is the natural next step — it turns the wired primitives into something an agent can call.
- **Live validation.** Point the gated smoke tests at a throwaway GitHub repo + Azure project to
  confirm the wiring against real APIs (especially the Azure board-column WEF write).
- **The `scm` port.** Branch/PR primitives — widens the contract to a second port (needs a
  conformance-suite extension in the same change, per CLAUDE.md).

## How to resume in this repo

1. Open a terminal at the repo root (`c:/Users/empad/Desktop/Development/baron`).
2. Run `claude` (a fresh session; cwd-scoped). It will load `CLAUDE.md` automatically.
3. Point it at this file + `ARCHITECTURE.md` and continue from "Agreed next step".
