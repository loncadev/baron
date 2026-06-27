# Session handoff

This repo was bootstrapped in a session that ran from the Beetegre V2 repository (the original
`.claude` Azure DevOps toolkit was the seed material). Work now continues from this repo. A Claude
Code session is bound to its working directory, so the conversation itself does not move — this
note plus [ARCHITECTURE.md](../ARCHITECTURE.md) and [CLAUDE.md](../CLAUDE.md) carry the context.

## Where we are

**Every package in the ARCHITECTURE layout now exists** — config engine, live transports, MCP
server, two ports (`issues` + `scm`), the recipe + plugin layer, and the knowledge loop — all
committed and green:

- `pnpm test` → 170/170 pass (+6 gated smoke skipped) · `pnpm typecheck` → clean (9 packages) ·
  `pnpm lint` → clean.
- Two capability ports now exist (invariant #1, "ports not a tracker"): `issues` and `scm`, each
  bound to a provider independently across **Azure DevOps** and **GitHub**.
- The `issues` port exposes all six primitives (ARCHITECTURE decision #6): `issue.create` /
  `get` / `transition` / `comment` / `link` / `query`. Same primitives produce correct-but-different
  behavior per provider; capability gaps (hierarchy, arbitrary states, issue links) are handled
  explicitly (`error` / `emulate` / `degrade`) and never silently. Two new capabilities — `comments`,
  `issueLinks` — and abstract `ISSUE_LINK_TYPES` were added; link-type→native is fixed provider
  knowledge supplied by the adapter (not `policy.json`).
- Config engine done (`baron init` + `baron doctor`): a committed `.baron/policy.json` is parsed,
  validated, and resolved into the issues config; introspection + a manifest-aware proposal draft a
  role/type/gap map for human confirmation; `doctor` reports drift against the live provider.
- Live transports + introspectors wired: GitHub via octokit, Azure via azure-devops-node-api. Both
  read `NativeTarget` keys verbatim (no role logic in the adapter, invariant #4); validated by
  typecheck + an adversarial multi-agent review + credential-gated smoke (not run without creds).
- `scm` port done: primitives `scm.branch.create` / `pr.create` / `pr.thread` with `BaseScmAdapter`
  + an `ScmManifest` (capabilities `draftPullRequests`, `pullRequestThreads`, both gap-negotiated).
  Live transports: GitHub (git refs + pulls + PR comment) and Azure Repos (updateRefs + GitApi PR +
  thread). The gap machinery was made port-agnostic (`resolveCapabilityGap`); both adapters pass
  `runScmConformance`.
- MCP server is now **multi-port**: a stdio `@modelcontextprotocol/sdk` server exposes the six
  `baron_issue_*` tools and the three `baron_scm_*` tools, advertising only the ports bound in
  `policy.json` and routing each call by name prefix (an unbound port → `PORT_UNBOUND` isError).
  Tool-input enums come from the core unions; `BaronError` surfaces as an `isError` result with the
  `.code`. Verified end-to-end over the MCP protocol via the SDK's in-memory transport pair.
- Recipe + plugin layer done: `@baron/recipes` is a declarative YAML engine (typed `ask` steps,
  `do` steps mapped 1:1 to port primitives, `message` steps, `${path}` interpolation) — workflow
  opinion lives in recipes, not the core (decisions #3/#6/#7). `baron run --recipe <path>` executes
  one against the policy's live ports; `plugins/claude-code` is the harness wrapper (MCP-server
  registration + a skill + `/baron-run`).
- Knowledge loop done (decision #11): `@baron/knowledge-loop` exposes `learning.append`/`query` +
  `followup.append`/`list` over a pluggable `KnowledgeStore` (in-memory + the default `local-md`
  store: one human-readable, CRLF-tolerant markdown file per record). The loop is always available;
  it's wired into the MCP server (`baron_learning_*` / `baron_followup_*` tools) and recipes
  (`learning.*` / `followup.*` ops), persisting under `.baron/knowledge`.

## What exists

- `@baron/core` — roles, capability manifest, gap policy, `RoleResolver`, `IssuesPort` +
  `BaseIssuesAdapter` (all translation logic lives here).
- `@baron/adapter-azure-devops`, `@baron/adapter-github` — issues manifest + example role/type/link
  maps + `define*IssuesAdapter` + **live** issues transport & introspector; plus the `scm` manifest +
  `define*ScmAdapter` + **live** scm transport (octokit / azure-devops-node-api). Gated smoke tests
  for both ports.
- `@baron/conformance` — in-memory issues + scm transports + in-memory introspector + the shared
  issues / introspection / scm suites every adapter passes.
- `@baron/knowledge-loop` — `KnowledgeLoop` (`learning`/`followup` primitives + filtering),
  `KnowledgeStore` contract + an in-memory store and the default `local-md` markdown store, an
  in-package store conformance suite, and `createLocalKnowledgeLoop(dir)`.
- `@baron/cli` — `baron init` / `baron doctor` / `baron run`. Pure command logic (`runInit` /
  `runDoctor` / `runRecipeFile`) behind injected `FileSystem` / `Prompter` / `RecipeAsker` ports
  (tested with in-memory fakes); thin Node-backed shell in `bin.ts`; a dependency-free flag parser.
- `@baron/recipes` — YAML recipe engine: `parseRecipe` / `loadRecipe`, `${path}` `interpolate`,
  `runRecipe(recipe, {ports, asker, inputs})`, the `RecipeAsker` contract, and shipped example
  recipes (`recipes/task-start.yaml`, `task-finish.yaml`). Pure mechanism — no role/native
  translation (that stays in the ports).
- `plugins/claude-code` — Claude Code plugin scaffold (not a workspace package): `plugin.json`
  registers the `baron` MCP server; a `baron` skill + `/baron-run` command. Validated by installing
  into Claude Code (no automated test).
- `@baron/providers` — shared infrastructure both the CLI and the MCP server depend on (so they
  don't depend on each other): the provider registry (id → issues + scm manifests, credential env
  keys, live transport / introspector / scm-transport factories), `buildIssuesPort` / `buildScmPort`,
  and the `.baron` path helpers.
- `@baron/mcp-server` — multi-port stdio MCP server (`baron-mcp` bin) exposing the bound ports'
  tools; `tools.ts` is pure/SDK-agnostic (issue + scm tool tables, prefix-routed `dispatchTool`),
  `server.ts` is the thin SDK wiring, `load.ts` (`loadPorts`) builds the issues/scm ports from
  policy + env.
- Core config-engine surface: `parsePolicy` / `serializePolicy` / `resolveIssuesConfig`
  (`policy-file.ts`); `Introspector` contract (`introspection.ts`); `proposePolicy` and friends
  (`proposal.ts`) — all impedance/translation logic, kept in core per invariant #4.

## Known debt (tracked, intentional)

- `LICENSE` holds an Apache-2.0 summary + URL; vendor the full canonical text before any public
  release.
- Live transports (issues + scm) have **never run against a real provider** here (no credentials).
  They are validated by typecheck, adversarial multi-agent reviews, and the in-memory conformance
  suites; the gated smoke tests are the first thing to run once real creds exist (set
  `GITHUB_OWNER/REPO/TOKEN` or `AZURE_DEVOPS_ORG/PROJECT/REPO/TOKEN`; scm smoke also reads
  `BARON_SMOKE_BASE_BRANCH`).
- `scm` config is minimal: it has no role/type map, so `policy.json` only needs `providers.scm`
  (plus optional `gapPolicy[scmProvider]`). `baron init` still configures the issues port only —
  extending init/credential-scaffolding to the scm port is deferred.
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
- The recipe DSL is intentionally a v1: no conditionals, loops, error handling, or idempotency
  markers yet (ARCHITECTURE "Deferred"). `${path}` refs inside a YAML *flow* map must be quoted
  (`{ id: "${x}" }`) or written in block style — a YAML quirk, not a Baron limitation.

## Agreed next step

The planned ARCHITECTURE is built end-to-end (config → ports → MCP → recipes → knowledge loop).
What remains is validation and expansion — not yet chosen; decide at the start of the next session:

- **Live validation (highest value).** Point the gated smoke tests at a throwaway GitHub repo +
  Azure project to confirm the wiring against real APIs (especially the Azure board-column WEF write,
  the issue query/link paths, and the scm branch/PR/thread paths), then drive the MCP server /
  `baron run` from a real client. Everything so far is verified in-memory / by adversarial review,
  never against a live provider.
- **`notify` / `docs` ports**, or a third issues/scm provider (Jira, Linear, GitLab), to further
  exercise the multi-provider bet.
- **Recipe DSL v2** (conditionals, error handling, idempotency markers) once a real workflow needs
  them.
- **Polish for release**: vendor the full LICENSE text; extend `baron init` to scaffold scm
  credentials; publish (`pnpm build` flips packages to `dist`).

## How to resume in this repo

1. Open a terminal at the repo root (`c:/Users/empad/Desktop/Development/baron`).
2. Run `claude` (a fresh session; cwd-scoped). It will load `CLAUDE.md` automatically.
3. Point it at this file + `ARCHITECTURE.md` and continue from "Agreed next step".
