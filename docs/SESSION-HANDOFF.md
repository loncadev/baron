# Session handoff

This repo was bootstrapped in a session that ran from the Beetegre V2 repository (the original
`.claude` Azure DevOps toolkit was the seed material). Work now continues from this repo. A Claude
Code session is bound to its working directory, so the conversation itself does not move — this
note plus [ARCHITECTURE.md](../ARCHITECTURE.md) and [CLAUDE.md](../CLAUDE.md) carry the context.

## Where we are

The foundation, the **first vertical slice**, and the **config engine** are committed and green:

- `pnpm test` → 78/78 pass · `pnpm typecheck` → clean (5 packages) · `pnpm lint` → clean.
- Slice scope: the `issues` port across **Azure DevOps** (rich: native hierarchy, state+column)
  and **GitHub** (flat: no hierarchy, binary states), to stress the impedance bet at its hardest.
- Proven: the same primitives (`issue.create`, `issue.transition`) produce correct-but-different
  behavior per provider; capability gaps are handled explicitly (`error` / `emulate` / `degrade`)
  and never silently.
- Config engine done (`baron init` + `baron doctor`): a committed `.baron/policy.json` is parsed,
  validated, and resolved into the issues config; introspection + a manifest-aware proposal draft a
  role/type/gap map for human confirmation; `doctor` reports drift against the live provider.

## What exists

- `@baron/core` — roles, capability manifest, gap policy, `RoleResolver`, `IssuesPort` +
  `BaseIssuesAdapter` (all translation logic lives here).
- `@baron/adapter-azure-devops`, `@baron/adapter-github` — manifest + example role/type maps +
  `define*IssuesAdapter` factory. Live transports are `NOT_IMPLEMENTED` stubs (deferred on purpose).
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
- Live SDK transports **and introspectors** (octokit / azure-devops-node-api) are not wired — both
  are `NOT_IMPLEMENTED` stubs. The translation layer is validated via the in-memory transport, and
  the config engine via the in-memory introspector. `baron init` / `baron doctor` therefore run
  end-to-end only with an injected introspector today; against a real provider they fail loudly at
  the introspection step until the SDK is wired.
- Reverse type-role resolution is lossy on providers that collapse all type roles to one native
  type (GitHub → `issue`). Faithful round-trip needs label emulation (same pattern as hierarchy).
- The proposal heuristics (board-column / type keyword matching) are English-biased and best-effort
  by design — every guess is recorded in `proposal.notes` for the human to confirm in `baron init`.

## Agreed next step

The config engine is done. The spine (`policy.json` + introspection contract) now exists, so the
queued options that depended on it are unblocked. Not yet chosen — decide at the start of the next
session:

- **Live SDK transports + introspectors (gated smoke).** Wire octokit / azure-devops-node-api into
  the `NOT_IMPLEMENTED` stubs so `issue.create` / `issue.transition` and `baron init` / `baron
  doctor` work against real providers. Validated by credential-gated smoke tests (never committed).
- **MCP server skeleton.** Expose the issues primitives over stdio MCP, reading the real
  `policy.json` via `resolveIssuesConfig`.
- **The `scm` port.** Branch/PR primitives — widens the contract to a second port.

## How to resume in this repo

1. Open a terminal at the repo root (`c:/Users/empad/Desktop/Development/baron`).
2. Run `claude` (a fresh session; cwd-scoped). It will load `CLAUDE.md` automatically.
3. Point it at this file + `ARCHITECTURE.md` and continue from "Agreed next step".
