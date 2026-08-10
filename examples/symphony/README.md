# Using Baron as Symphony's write path

[Symphony](https://github.com/openai/symphony) is an orchestrator: it polls a tracker, claims work,
prepares an isolated workspace per issue, and runs a coding agent against it. It is deliberately not
a work-tracking contract, and its specification says so directly:

> **§11.5 Tracker Writes and Agent Tools (Important Boundary)** — Symphony does not require
> first-class tracker write APIs in the orchestrator. Ticket mutations (state transitions, comments,
> attachments, PR metadata) are typically handled by the coding agent through the selected adapter's
> provider-native tools.

Both of Symphony's required adapter functions — `fetch_issues_by_states` and `fetch_issues_by_ids` —
are reads. Writing is left to the agent, and the reference workflow reflects that: it lists *"Linear
MCP or `linear_graphql` tool"* as a prerequisite and has the agent call `update_issue(..., state:
"In Progress")` with the provider's own state name.

That last detail is the gap worth closing. A native state name in a prompt is the thing that breaks
when a board column is renamed, when a second project uses a different workflow, or when the tracker
changes. It is also what an agent gets wrong when it has to infer a provider's state machine.

## What this example does

[`WORKFLOW.md`](./WORKFLOW.md) is a Symphony workflow whose agent instructions route every work-item
change through Baron instead. Symphony keeps doing what it is good at — polling, claiming,
concurrency, workspace isolation, retries. Baron supplies the part Symphony leaves out:

| | Symphony | Baron |
|---|---|---|
| Poll, claim, schedule | ✅ | — |
| Workspace per issue | ✅ | — |
| Read issues | ✅ | ✅ |
| **Write issues** | out of scope (§11.5) | ✅ |
| Role vocabulary instead of native states | — | ✅ |
| Human-confirmed, committed state mapping | — | ✅ |
| Capability gaps negotiated, never silent | — | ✅ |
| Branch naming derived, not invented | — | ✅ |

The workflow body ends up shorter than the reference one, because the ordering and guards it would
otherwise spell out in prose live inside Baron's recipes.

## Setup

1. Configure Baron in the repository Symphony will clone:

   ```bash
   npx -y @lonca/baron-cli@latest init --provider github   # or: --provider azure-devops
   npx -y @lonca/baron-cli@latest doctor
   ```

   `.baron/policy.json` is committed; credentials are not. A fresh Symphony workspace clones the repo
   and picks up the policy automatically.

2. Make the Baron MCP server available to the agent Symphony launches, following that agent's own MCP
   configuration.

3. Copy [`WORKFLOW.md`](./WORKFLOW.md) into the repository root and fill in the front matter: the
   tracker `kind`, its `provider` block, and the state lists. Those are **provider-native** names —
   keep them consistent with the role map you confirmed at `baron init`.

## Honest limits

- **Symphony is early.** v0.0.2, described by its own README as an engineering preview. Its scope may
  move.
- **It is bound to Codex.** §10 defines the agent runner in terms of the Codex app-server protocol
  and names that protocol as the source of truth on conflict. Other agents need a shim.
- **Baron is not a Symphony tracker adapter.** Adapters are in-process Elixir behaviours; Baron is
  TypeScript. This example wires Baron in as the agent's *write path*, which needs no Elixir at all.
  A native adapter — Azure DevOps in particular, which Symphony does not support and Baron does —
  would be a separate piece of work.
