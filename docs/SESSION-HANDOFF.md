# Session handoff

This repo was bootstrapped in a session that ran from the Beetegre V2 repository (the original
`.claude` Azure DevOps toolkit was the seed material). Work now continues from this repo. A Claude
Code session is bound to its working directory, so the conversation itself does not move — this
note plus [ARCHITECTURE.md](../ARCHITECTURE.md) and [CLAUDE.md](../CLAUDE.md) carry the context.

## Where we are

The foundation, the **first vertical slice**, the **config engine**, the **live SDK transports +
introspectors**, and the **MCP server** are committed and green:

- `pnpm test` → 92/92 pass (+4 gated smoke skipped) · `pnpm typecheck` → clean (7 packages) ·
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
- MCP server done: a stdio `@modelcontextprotocol/sdk` server exposes the three issue primitives as
  `baron_issue_create` / `baron_issue_get` / `baron_issue_transition` (tool-input enums sourced from
  the core role unions; `BaronError` surfaced as an `isError` result with the `.code`). Loads the
  real `policy.json` and binds the live transport at startup; verified end-to-end over the MCP
  protocol via the SDK's in-memory transport pair.

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
  Node-backed shell in `bin.ts`; a dependency-free flag parser.
- `@baron/providers` — shared infrastructure both the CLI and the MCP server depend on (so they
  don't depend on each other): the provider registry (id → manifest, credential env keys, live
  transport + introspector factories), `buildIssuesPort(config, env)`, and the `.baron` path helpers.
- `@baron/mcp-server` — stdio MCP server (`baron-mcp` bin) exposing the issue primitives;
  `tools.ts` is pure/SDK-agnostic, `server.ts` is the thin SDK wiring, `load.ts` builds the port
  from policy + env.
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

The config engine, the live transports/introspectors, and the MCP server are done — the `issues`
port is now usable end-to-end by an agent (CLI to configure, MCP to drive). Remaining queued
options — not yet chosen; decide at the start of the next session:

- **Live validation.** Point the gated smoke tests at a throwaway GitHub repo + Azure project to
  confirm the wiring against real APIs (especially the Azure board-column WEF write), then drive the
  MCP server from a real client. This is the highest-value next step — everything so far is verified
  in-memory/by review, never against a live provider.
- **More issue primitives.** `issue.link` / `issue.query` / `issue.comment` (ARCHITECTURE decision
  #6) — extend `IssuesPort` + the conformance suite + the MCP tool table in one change.
- **The `scm` port.** Branch/PR primitives — widens the contract to a second port (needs a
  conformance-suite extension in the same change, per CLAUDE.md).
- **Recipes + knowledge-loop + the Claude Code plugin** (declarative workflow layer; the remaining
  packages in the ARCHITECTURE layout).

## How to resume in this repo

1. Open a terminal at the repo root (`c:/Users/empad/Desktop/Development/baron`).
2. Run `claude` (a fresh session; cwd-scoped). It will load `CLAUDE.md` automatically.
3. Point it at this file + `ARCHITECTURE.md` and continue from "Agreed next step".
