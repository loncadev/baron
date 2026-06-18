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

| Port      | Providers                                                         |
| --------- | ---------------------------------------------------------------- |
| `issues`  | Azure Boards, Jira, Linear, GitHub Issues, GitLab Issues, Asana  |
| `scm`     | Azure Repos, GitHub, GitLab                                      |
| `notify`  | Slack                                                            |
| `docs`    | Notion, Confluence                                              |

A real org mixes them (e.g. Linear issues + GitHub PRs + Slack notify + Notion docs), so each
port binds to a provider independently.

## Decisions

| #  | Area              | Decision                                                                                  |
| -- | ----------------- | ----------------------------------------------------------------------------------------- |
| 1  | Substrate         | Deterministic **TypeScript** core, exposed as an **MCP server + CLI**                      |
| 2  | Harness           | Cross-harness via MCP; Claude Code gets a rich **plugin** wrapper                          |
| 3  | Capability model  | Independent **ports** (`issues` / `scm` / `notify` / `docs`), mix-and-match providers      |
| 4  | Provider impedance| **Semantic role layer**, introspected + **human-confirmed** mapping                        |
| 5  | Adapters          | **Capability manifest** + explicit **degrade / emulate / error** policy, never silent      |
| 6  | API grain         | Core exposes **primitives**; workflows are **portable declarative recipes** (YAML)         |
| 7  | Interactivity     | Recipes use typed **`ask` steps**, rendered per harness (CC `AskUserQuestion`, CLI prompt) |
| 8  | P0 providers      | **Azure DevOps + GitHub** (`issues`+`scm`), **Slack** (`notify`)                           |
| 9  | Config            | `policy` (committed) / `credentials` (gitignored) split; `baron init` + `baron doctor`     |
| 10 | Auth              | Static tokens via env; **pluggable secret-manager hook**; OAuth apps deferred to v2        |
| 11 | Knowledge loop    | v1: `learning` / `followup` primitives + recipes + **pluggable store** (local-md default)  |
| 12 | Repo              | **Monorepo** (pnpm workspaces)                                                             |
| 13 | License           | **Open-core** (OSS: core + P0 adapters + recipes + CLI/MCP)                                |
| 14 | i18n              | `language.interaction` vs `language.artifacts` + per-artifact override; translatable templates |
| 15 | Testing           | Per-adapter **capability conformance suite** + recorded fixtures (CI) + gated live smoke   |
| 16 | Proof             | A second Azure DevOps project; Beetegre V2 ships as a reference policy example             |

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

## First vertical slice (in progress)

The `issues` port across **Azure DevOps and GitHub** — the two most divergent providers — to
stress the central bet (impedance via role layer + manifest) at its hardest point:

- `issue.create` and `issue.transition` primitives
- both adapters with manifests + role mapping + gap policy (GitHub hierarchy → emulate via labels)
- a conformance suite both adapters pass (pure mapping logic with fixtures; live smoke gated by creds)
