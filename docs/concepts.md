# Concepts

Baron's whole job is to let you (or an agent) speak one abstract language and have it work correctly
against very different providers. Six ideas carry that.

## 1. Capability ports

Work is split into independent **ports**, each bound to a provider on its own:

- `issues` — work items / tickets.
- `scm` — branches and pull requests.
- `ci` — pipelines and runs (Azure Pipelines, GitHub Actions).
- `deploy` — environments and deployments (Azure Environments, GitHub Environments).
- `notify` — messages (Slack).
- `docs` — planned (v2); binding `policy.providers.docs` throws `DOCS_UNSUPPORTED` for now.

A single install can mix providers: Linear `issues` + GitHub `scm` + Slack `notify`. Nothing assumes
one vendor spans everything. You bind ports in `policy.providers`. The `ci` and `deploy` ports reuse
the same provider credentials and coordinates as `issues`/`scm` — no extra env keys and no `baron
init` step, because their status maps are vendor-fixed adapter knowledge, not something a human
confirms.

## 2. Semantic roles

Providers model status too differently for a universal schema, so Baron never speaks native states.
It speaks **abstract roles**, and a per-provider map translates them:

- **Workflow roles:** `backlog → ready → in_progress → in_review → done`, plus `blocked` (orthogonal).
- **Type roles:** `initiative`, `epic`, `story`, `task`, `subtask`.
- **Link types:** `relates`, `blocks`, `blocked_by`, `duplicates`.

`baron init` introspects the provider's real vocabulary and proposes the map; you confirm it once. A
recipe that says "move to `in_review`" works whether that means Azure state `Test` + board column
`Test`, or a GitHub `in-review` label.

The `ci` and `deploy` ports speak the same way, with their own normalized vocabularies parallel to
the workflow roles:

- **CI `RunStatus`:** `queued | running | succeeded | failed | canceled | skipped | waiting | unknown` —
  collapsed from each provider's native phase + result (so an Azure Pipelines `inProgress` and a
  GitHub Actions `in_progress` both read as `running`).
- **Deploy `DeployStatus`:** `pending | running | succeeded | failed | canceled | skipped | unknown`.

Unlike issue roles, these maps aren't confirmed during `init` — provider CI/deploy enums are fixed
and well-known, so Baron ships the translation as adapter knowledge.

## 3. Capability gaps are never silent

Providers differ in what they *can* do (GitHub issues have no native hierarchy or arbitrary states;
Azure Boards do). When an operation needs a capability the provider lacks, the configured **gap
policy** decides — explicitly:

- `error` — fail loudly with an actionable message (the strict default).
- `emulate:<strategy>` — synthesize it (e.g. GitHub hierarchy/links via labels).
- `degrade` — skip it, but always log a warning.

A gap that is neither errored nor logged is a bug. The same machinery governs every port (issue
hierarchy, arbitrary states, issue links; PR drafts and threads).

## 4. Primitives vs. recipes

- The **core** exposes deterministic primitives only: `issue.create`, `issue.transition`,
  `scm.pr.create`, `learning.append`, … No opinion about *when* to use them.
- **Recipes** are declarative YAML that compose primitives into a workflow ("start a task", "open a
  PR and move it to review"). All workflow *opinion* lives here, editable, outside the code.

This keeps the provider abstraction testable and stable while teams customize process freely.

## 5. The knowledge loop

Beyond one-shot actions, Baron persists `learning` and `followup` records across runs (decision #11)
via a pluggable store (local markdown by default, under `.baron/knowledge`). An agent can append a
learning, query past ones, and track follow-ups — durable, human-readable, committable knowledge.

## 6. The escape hatch

The normalized ports cover the common cases; when you need something a port doesn't expose yet,
`baron_native_request` (decision #18) makes a raw authenticated REST call straight to a provider.
It is the deliberate **last resort** — clearly labeled and **non-portable**, because you're now
speaking a vendor's native API instead of an abstract role. It can only reach providers the policy
already binds. Prefer the normalized tools every time they fit; reach for the hatch only when they
don't.

## How a request flows

```
recipe / MCP tool call
      │  (abstract: role, type role, link type)
      ▼
BaseIssuesAdapter / BaseScmAdapter   ← all role↔native translation + gap negotiation
      │  (native: state, board column, label, ref name)
      ▼
provider transport (octokit / azure-devops-node-api)   ← provider I/O only, no translation
```

Adapters contribute only a capability manifest + a transport; everything abstract↔native happens in
the shared core. That's why a new provider is a thin adapter, not a fork.
