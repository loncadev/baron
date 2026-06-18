# Session handoff

This repo was bootstrapped in a session that ran from the Beetegre V2 repository (the original
`.claude` Azure DevOps toolkit was the seed material). Work now continues from this repo. A Claude
Code session is bound to its working directory, so the conversation itself does not move — this
note plus [ARCHITECTURE.md](../ARCHITECTURE.md) and [CLAUDE.md](../CLAUDE.md) carry the context.

## Where we are

The foundation and the **first vertical slice** are committed and green:

- `pnpm test` → 25/25 pass · `pnpm typecheck` → clean (4 packages) · `pnpm lint` → clean.
- Slice scope: the `issues` port across **Azure DevOps** (rich: native hierarchy, state+column)
  and **GitHub** (flat: no hierarchy, binary states), to stress the impedance bet at its hardest.
- Proven: the same primitives (`issue.create`, `issue.transition`) produce correct-but-different
  behavior per provider; capability gaps are handled explicitly (`error` / `emulate` / `degrade`)
  and never silently.

## What exists

- `@baron/core` — roles, capability manifest, gap policy, `RoleResolver`, `IssuesPort` +
  `BaseIssuesAdapter` (all translation logic lives here).
- `@baron/adapter-azure-devops`, `@baron/adapter-github` — manifest + example role/type maps +
  `define*IssuesAdapter` factory. Live transports are `NOT_IMPLEMENTED` stubs (deferred on purpose).
- `@baron/conformance` — in-memory transport + the shared suite both adapters pass.

## Known debt (tracked, intentional)

- `LICENSE` holds an Apache-2.0 summary + URL; vendor the full canonical text before any public
  release.
- Live SDK transports (octokit / azure-devops-node-api) are not wired — the slice validates the
  translation layer via the in-memory transport.
- Reverse type-role resolution is lossy on providers that collapse all type roles to one native
  type (GitHub → `issue`). Faithful round-trip needs label emulation (same pattern as hierarchy).

## Agreed next step

**Config engine: `baron init` + `baron doctor`.** Rationale: both the live SDK transports and the
MCP server depend on a real `policy.json` + introspection, so building the config/role-mapping
spine first feeds everything else.

- `baron init` — introspect a provider (work-item types, states, board columns, iterations),
  propose a role map, get human confirmation, write `policy.json` (committed) and wire credentials
  (env / secret-manager hook; never committed).
- `baron doctor` — validate `policy.json` against the live provider and report drift.

Other queued options (not chosen): live SDK transports + gated smoke; the `scm` port; the MCP
server skeleton.

## How to resume in this repo

1. Open a terminal at the repo root (`c:/Users/empad/Desktop/Development/baron`).
2. Run `claude` (a fresh session; cwd-scoped). It will load `CLAUDE.md` automatically.
3. Point it at this file + `ARCHITECTURE.md` and continue from "Agreed next step".
