# Baron — Architecture Decision Record

Baron is a **platform-agnostic work-orchestration layer for AI coding agents**. It lets an
agent (or a CI pipeline) drive work-tracking, source control, and notifications across many
providers through one normalized contract, instead of hardwiring one vendor's API and process
template into prompts.

This document is the single source of truth for the foundational decisions. Implementation
details that are explicitly *not* settled here are listed under "Deferred".

## Problem

Agentic DevOps tooling is almost always coupled to one platform (usually GitHub) and one
team's process template. Beetegre V2's `.claude` toolkit, for example, has the org (`beekod`),
project (`Beetegre-V2`), the Scrum process (4 states / 7 board columns / `bugsBehavior=AsTasks`),
the hierarchy (Epic→Feature→PBI→Bug/Task), branch conventions, and specialist routing baked
directly into skill prompts. That is roughly 65-75% reusable mechanism wrapped around 25-35%
hardcoded policy. Baron extracts the mechanism and turns the policy into configuration.

The listed target platforms are **not one category**. They map to independent capability ports:

| Port                       | Providers                                                         |
| -------------------------- | ---------------------------------------------------------------- |
| `issues`                   | Azure Boards, Jira, Linear, GitHub Issues, GitLab Issues, Asana  |
| `scm`                      | Azure Repos, GitHub, GitLab                                      |
| `ci` / `pipelines`         | Azure Pipelines + GitHub Actions *(shipped: read + trigger/cancel + stages)*; GitLab CI *(v2)* |
| `deploy` / `environments`  | Azure Environments + GitHub Environments *(read shipped)* |
| `notify`                   | Slack *(shipped)*                                                |
| `docs`                     | Notion, Confluence *(v2 — declared but unimplemented; binding it errors)* |

A real org mixes them (e.g. Linear issues + GitHub PRs + Slack notify + Notion docs), so each
port binds to a provider independently. The audience — full-stack developers and **solopreneurs**
who want to run their whole loop from one place — is why the port set grows to cover CI/CD and
deployment, not just work tracking (decision #17).

## Decisions

| #  | Area              | Decision                                                                                  |
| -- | ----------------- | ----------------------------------------------------------------------------------------- |
| 1  | Substrate         | Deterministic **TypeScript** core, exposed as an **MCP server + CLI**                      |
| 2  | Harness           | Cross-harness via MCP; Claude Code gets a rich **plugin** wrapper                          |
| 3  | Capability model  | Independent **ports** (`issues` / `scm` / `ci` / `deploy` / `notify` / `docs`), mix-and-match providers |
| 4  | Provider impedance| **Semantic role layer**, introspected + **human-confirmed** mapping                        |
| 5  | Adapters          | **Capability manifest** + explicit **degrade / emulate / error** policy, never silent      |
| 6  | API grain         | Core exposes **primitives**; workflows are **portable declarative recipes** (YAML)         |
| 7  | Interactivity     | Recipes use typed **`ask` steps**, rendered per harness (CC `AskUserQuestion`, CLI prompt) |
| 8  | P0 providers      | **Azure DevOps + GitHub** (`issues`+`scm`+`ci`+`deploy`), **Slack** (`notify`) — all shipped |
| 9  | Config            | `policy` (committed) / `credentials` (gitignored) split; `baron init` + `baron doctor`     |
| 10 | Auth              | Static tokens via env; **pluggable secret-manager hook**; OAuth apps deferred to v2        |
| 11 | Knowledge loop    | v1: `learning` / `followup` primitives + recipes + **pluggable store** (local-md default)  |
| 12 | Repo              | **Monorepo** (pnpm workspaces)                                                             |
| 13 | License           | **Open-core** (OSS: core + P0 adapters + recipes + CLI/MCP)                                |
| 14 | i18n              | `language.interaction` vs `language.artifacts` + per-artifact override; translatable templates |
| 15 | Testing           | Per-adapter **capability conformance suite** + recorded fixtures (CI) + gated live smoke   |
| 16 | Proof             | A second Azure DevOps project; Beetegre V2 ships as a reference policy example             |
| 17 | Scope & audience  | **Single pane of glass** for full-stack devs & **solopreneurs**: grow ports across the dev lifecycle — `ci`/`pipelines`, `deployments`/`environments`, `scm` monitoring — so the agent need not fall back to a raw provider tool |
| 18 | Coverage principle| **Normalize, don't raw-proxy.** New capabilities become ports with a semantic status layer (like roles); a **labeled provider-native escape hatch** is the explicit last resort, never the default path |
| 19 | Workflow packaging | A recipe runs as **one deterministic, rule-enforced call** (`baron_recipe_run`) — the engine enforces step order, not the agent. Workflows are surfaced to harnesses as **skills, not slash commands** (commands have merged into skills); each per-recipe skill gathers inputs + makes the single call |
| 20 | Monetization & entitlements | **Open-core boundary set at inception, but no entitlement machinery until a paying design-partner.** OSS stays **Apache-2.0** (client-side glue, not a hyperscaler-resellable stateful service → source-available would only cost adoption); commercial line = SSO, audit aggregation, multi-team governance, hosted secret-manager, cloud. Preserve the relicense *option* with a **CLA/DCO before the first external PR** + **trademark the name** + **dep-license scanning in CI** — the only irreversible-if-skipped moves. **Defer** the `Entitlements` code seam, signed-offline license, private repo, and cloud until real demand |

## The semantic role layer (decision #4)

Providers model work too differently for a canonical entity model to be anything but lossy
(Azure's state-vs-board-column split, Jira transition guards, Linear cycles, GitHub's flat
open/closed issues). Instead, Baron defines a small set of abstract **workflow roles**:

```
backlog -> ready -> in_progress -> in_review -> done
                         |
                       blocked (orthogonal)
```

`baron init` introspects each provider's *actual* states/types and proposes a role mapping; a
human confirms it. Recipes and primitives speak roles ("transition to `in_review`"); the
adapter translates a role to the provider-native state/column/label. This sidesteps a universal
schema by making **each installation's config describe its own reality**.

## The capability manifest (decision #5)

Not every provider supports every operation (GitHub has no native hierarchy; its issues have
only open/closed). Each adapter declares a manifest:

```ts
{ hierarchy: false, subIssues: true, separateBoardColumn: false, sprints: false, ... }
```

When an operation needs a missing capability, behavior is decided by **policy**, never silent:

- `error`   — strict; fail with a clear, actionable message
- `emulate`  — synthesize it (e.g. GitHub hierarchy via labels / native sub-issues)
- `degrade`  — skip with an explicit warning

## API grain (decision #6)

The core MCP server exposes **primitives** only:

```
issues:  issue.create | issue.get | issue.transition | issue.link | issue.query | issue.comment
scm:     scm.branch.create | scm.pr.create | scm.pr.thread
notify:  notify.send
loop:    learning.append | learning.query | followup.append | followup.list
```

Workflow *opinion* (when to move to `in_review`, what the PR body looks like, hierarchy rules)
lives in **declarative recipes** outside the core, so teams can edit it. The deterministic
guarantees we want (role↔native translation, atomic state+column patch, idempotent transition)
live inside the primitive.

### Recipes run as one deterministic call; harnesses see skills (decision #19)

A packaged workflow must run **the same way every time** — so the *engine* enforces the step order,
not the agent improvising the primitives. The recipe runner (`baron_recipe_run` over MCP; `baron run
--recipe` on the CLI) executes a named recipe end-to-end with inputs supplied **up front** (a missing
required input fails with `RECIPE_INPUT_MISSING` rather than prompting — runs are headless and
deterministic). This is the reliability win over telling the agent "now create an issue, then a
branch, then…": the order and rules are code, not reasoning.

Harnesses surface these workflows as **skills**, not slash commands — Claude Code merged custom
commands into skills, and skills add discovery-by-description (natural language) and supporting files
on top of the `/name` invocation. Each per-recipe skill (`task-start`, `task-finish`, `ship`, plus a
generic `run-recipe`) is *thin*: it gathers the declared inputs and makes the single
`baron_recipe_run` call, with a strict instruction not to hand-compose the primitives. The skill is
the discovery + input-gathering layer; the engine is the deterministic executor.

## Coverage roadmap: the single pane of glass (decisions #17–#18)

The first audience is full-stack developers and **solopreneurs** who want to run their entire loop —
plan work, write code, ship, watch it — from one agent-driven layer, without dropping to a raw
provider tool (a vendor MCP, a web console). So the port set deliberately grows beyond work tracking
to the rest of the developer lifecycle:

- **`ci` / `pipelines`** — `ci.runs(query)`, `ci.run.get`, `ci.run.trigger`, `ci.run.cancel`,
  `ci.logs` (size-aware — a lean projection by default; full logs on request). Build/run status is a
  **semantic layer just like workflow roles**: `queued | running | succeeded | failed | canceled |
  skipped` (+ `waiting` for approval gates), mapped onto Azure Pipelines (`state` + `result`), GitHub
  Actions (`status` + `conclusion`), GitLab CI, etc. Manifest capabilities: `canTrigger`, `canCancel`,
  `hasStages`, `hasApprovalGates`, `providesLogs`, `hasArtifacts`.
- **`deployments` / `environments`** — environment status, deployment history, approval gates.
- **`scm` monitoring** — PR checks / review state / mergeability (the code side of "developer
  monitoring").

### The coverage principle: normalize, don't raw-proxy (decision #18)

Mirroring a provider's REST surface 1:1 would forfeit the one thing that justifies Baron — portability
of the same recipes/prompts across providers — and reduce it to a fatter vendor MCP. So every new
capability is brought in as a **normalized port** with its own semantic status mapping and capability
manifest, exactly as `issues` did with workflow roles. Read primitives carry the query-size discipline
learned in dogfooding: lean projections by default, full detail on explicit fetch.

A **provider-native escape hatch** exists for the solopreneur's "never be blocked" need: when a needed
API is not yet normalized, a single, **clearly-labeled** passthrough capability can reach it. It is the
**last resort, not the default** — using it is an explicit, non-portable action (consistent with
invariant #5: gaps are never silent). The normalized ports are always the first-class path; the escape
hatch is what keeps the tool usable at the edges while normalization catches up.

## Monetization & entitlements (decision #20)

Baron is **open-core** (decision #13). The *boundary* is set now, but the *machinery* is deferred —
a decision stress-tested by four adversarial reviews (commercialization, licensing/IP, enforcement,
community/lean). Their consensus, and the reasoning worth preserving:

**OSS license stays Apache-2.0.** The instinct to go source-available (BSL/FSL/SSPL) to "protect the
moat before a fork" is wrong *for this category*. Every cited relicensing war — HashiCorp→OpenTofu,
Redis→Valkey, Elastic→OpenSearch — was **stateful infrastructure a hyperscaler resells as a managed
service**, and the backlash was triggered by *relicensing already-open, already-adopted code*. Baron
is client-side **glue** (npm packages + MCP server + CLI); a hyperscaler does not monetize it, so the
BSL rationale does not apply, and source-available would only cost the **adoption that is the actual
moat** (breadth of adapters + recipe ecosystem + mindshare — an execution moat, not a legal one).

**Preserve the *option*, don't pay for it now.** The one genuinely irreversible risk is foreclosing a
future relicense: Apache-2.0 grants no relicensing right, so a single outside PR permanently removes
the option unless contributor rights are secured up front. Therefore the only "do-now" moves are the
cheap, irreversible-if-skipped ones:

- **CLA (or DCO + explicit relicense grant) before the first external PR** — keeps dual-license/
  relicense legally possible without every contributor's consent. Zero-cost while solo; shuts on merge #1.
- **Trademark the product name** — "fork the code, not the brand" is the real solo-dev moat (Apache
  grants no trademark rights). Needs a clearance search first.
- **Dependency-license scanning in CI** — denylist AGPL/SSPL/GPL/CC-NC so no transitive dep poisons a
  permissive or (future) commercial artifact.

**Commercial line = naturally server-side / relationship-gated features:** SSO/SAML, audit-log
aggregation, multi-team governance, hosted secret-manager, and a possible thin hosted registry —
kept in a **separate private repo + private packages** under a purpose-built source-available license
(e.g. Elastic License v2, whose anti-circumvention + no-managed-service clauses fit) that **depends
on** the Apache core and never mixes into OSS packages. Note the likely real *wedge* is **team-
coordination / cross-provider sync** (the moment 2+ people share a role-mapping or policy), not SSO —
SSO/audit is a late enterprise upsell, not the thing that first converts.

**Deferred until a validated paying design-partner exists** (avoid pre-PMF over-engineering + the
"commercialization theater" optics of shipping a tollbooth before a user): the `Entitlements` /
`LicenseProvider` code seam, the signed-offline license validator, the private repo/packages, and any
cloud offering. When built, bank these corrections:

- The entitlement **check** lives in the **OSS core, transparent**; the **paid feature
  *implementations*** live behind the closed package/server. Closing the *validator* buys nothing
  (the call sites are still open) — the value of a closed package is IP separation + proprietary
  logic, not enforcement.
- **Never brick a paying customer:** expiry *degrades* paid features, never blocks core/CI; 30-day
  grace + early warnings; no network call on any critical path (air-gapped/CI must work); clock-skew
  tolerance; seat counts are honor-system attestation offline (audit, not enforcement). Buyers pay
  because piracy is a **legal/audit liability**, not because DRM is unbreakable — so spend **zero**
  effort on obfuscation/anti-tamper.

Meanwhile the highest-leverage work is unchanged and comes first: **adoption** — a killer demo, a
README that sells the single-pane pain in 60 seconds, and distribution — with $0-code monetization
(GitHub Sponsors, paid support, hosted-beta waitlist) validating willingness-to-pay before any
entitlement code is written.

## Repository layout

```
baron/
  packages/core             # roles, config engine, capability manifest + gap policy, port contracts
  packages/adapters/azure-devops
  packages/adapters/github
  packages/adapters/slack
  packages/mcp-server       # primitive tools over stdio MCP
  packages/cli              # baron init | doctor | run | mcp
  packages/knowledge-loop   # learning/followup primitives + pluggable store
  packages/recipes          # task-start/finish/new ... (yaml + ask steps)
  packages/conformance      # the suite every adapter must pass
  plugins/claude-code       # agent + skills that render recipes
  examples/azure-proof      # proof-project policy + Beetegre reference policy
```

## Configuration shape

```jsonc
// .baron/policy.json  (committed)
{
  "providers": { "issues": "azure-devops", "scm": "azure-devops", "notify": "slack" },
  "roleMap": {
    "azure-devops": {
      "in_progress": { "state": "Active", "boardColumn": "In Progress" },
      "in_review":   { "state": "Test",   "boardColumn": "Test" }
    },
    "github": { "in_progress": { "label": "in-progress" }, "in_review": { "label": "in-review" } }
  },
  "gapPolicy": { "hierarchy": "emulate:labels" },
  "language": { "interaction": "tr", "artifacts": "en" }
}
```

Credentials live outside the repo (`.baron/credentials`, env, or a secret-manager hook) and are
never committed.

## Deferred (not blocking the first slice)

- Recipe DSL full schema (conditionals, error handling, idempotency markers)
- Adapter SDK published interface + versioning/compat strategy
- Telemetry / audit log (enterprise / commercial tier)
- OAuth app flows (GitHub App, Slack OAuth, Azure OAuth)
- Additional adapters: Jira, Linear, GitLab, Asana, Notion
- Commercial tier features: SSO, secret-manager integrations, multi-team governance
- **Entitlements machinery (decision #20): deferred until a validated paying design-partner** — the
  `Entitlements`/`LicenseProvider` seam, signed-offline license validator, private enterprise repo/
  packages, and cloud offering. Building any of it pre-demand is over-engineering; the open-core
  *boundary* and license posture are set now, the *machinery* is not

## Vertical slices

**Slice 1 — shipped.** The `issues` + `scm` ports across **Azure DevOps and GitHub** — the two most
divergent providers — proving the central bet (impedance via role layer + manifest) at its hardest
point: `issue.create/transition/...` primitives, both adapters with manifests + role mapping + gap
policy (GitHub hierarchy → emulate via labels), the conformance suite both adapters pass, the MCP
server + CLI + recipe engine + knowledge loop, and a live dogfood against a real Azure DevOps project.

**Slice 2 — in progress (decision #17).** The `ci` / `pipelines` port: the same semantic-layer pattern
applied to build/run status (a `RunStatus` vocabulary; per-adapter status maps since CI statuses are
vendor-fixed). **Shipped:** the core contract + `BaseCiAdapter`, the conformance suite, the read
primitives (`pipelines` / `runs` / `run.get` / `logs`, size-aware) on **both Azure Pipelines and
GitHub Actions** (the two most divergent CI models, proving the `RunStatus` layer is cross-provider —
Azure validated live), the MCP read tools, and the **write primitives (`trigger` / `cancel`)** on both
providers — a real impedance modelled honestly (Azure returns the queued/cancelled build; GitHub's
`workflow_dispatch` is fire-and-forget so `trigger` returns `{accepted, run?}` with no run id, and
cancel re-reads the run), and **per-stage status** in run detail (Azure build timeline → Stage/Job
records; GitHub run jobs — both normalized onto `RunStatus`, validated live on a multi-stage Azure
pipeline).

**Slice 3 — shipped (single pane of glass, #17/#18).** The remaining ports + the escape hatch, each
with the conformance suite + per-adapter status maps:
- **`notify`** (decision #8 P0): core port + the **Slack** adapter (`chat.postMessage`, channels +
  threads); `baron_notify_send`.
- **`deploy` / environments** (#17): Azure Environments + GitHub Environments, normalized
  `DeployStatus`; `baron_deploy_environments` / `deployments`.
- **`scm` monitoring** (#17): `scm.pr.status` → normalized state / review decision / mergeability /
  checks rollup.
- **Provider-native escape hatch** (#18): `baron_native_request`, scoped to policy-bound providers.
- Recipe ops for all of the above (`recipes/ship.yaml` composes scm + issues + ci + notify).

**Next (v2):** the GitLab / Jira / Linear / Notion adapters and the `docs` port. The ci/deploy/notify/
escape-hatch surfaces are conformance-tested; only the Azure ci read path has been validated live so far.
