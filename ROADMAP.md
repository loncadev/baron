# Baron — Roadmap

Baron is the layer that lets your coding agent **write** to your work tracker — the same flow
running unchanged on Azure DevOps, GitHub, or Jira.

This file states where Baron is going and, just as importantly, where it is not. Individual work
is tracked as [GitHub issues](https://github.com/loncadev/baron/issues), grouped into the three
gates below. [ARCHITECTURE.md](./ARCHITECTURE.md) remains the source of truth for *why* the system
is shaped the way it is; this file is only about sequence.

## Where Baron is today

The `issues`, `scm`, `ci`, `deploy`, and `notify` ports ship with a conformance suite each, across
Azure DevOps, GitHub, and Slack. Workflows run as deterministic YAML recipes through one call. What
is missing is not capability — it is the discipline of a tool that has been installed by someone
other than its author.

The next three gates are about closing that distance, in order.

## Gate 1 — Foundation and message

Get the contributor and licensing groundwork right while it is still cheap, make the README describe
what Baron actually does, and put Baron on Baron: this repository's own issues, branches, and pull
requests are managed through Baron's GitHub adapter, with the role labels (`in-progress`,
`in-review`, `done`) mapped exactly as `exampleGithubRoleMap` describes.

Dogfooding here is a test, not a feature pipeline. When Baron hits a gap while running this
repository, that gap is filed and labelled — it does not become a reason to grow the surface.

## Gate 2 — Installability and reach

Today Baron publishes 34 MCP tools. Cursor caps a session at 40 tools in total, so Baron alone
consumes most of a user's budget and cannot be installed next to the provider MCP servers it is
meant to sit above. That is the opposite of the point.

This gate consolidates the tool surface by verb rather than by endpoint, ships a default toolset of
around seven tools, and uses something no other server can: `policy.json` already knows which ports
are bound, so tools for unbound ports are never published at all.

Alongside it: a short demo that shows one recipe moving a work item and opening a pull request, and
registration on the surfaces where MCP servers are actually discovered.

## Gate 3 — Contract debt and first users

Three defects in the role contract are known and scheduled here, while the cost of changing them is
still near zero:

- `blocked` is currently a member of `WORKFLOW_ROLES`, so transitioning to it destroys the previous
  role. It is documented as orthogonal and must become orthogonal — a relation, not a state. Jira,
  Linear, and GitLab all model it this way.
- `applyTarget` assumes a state can be set directly. Jira requires discovering the available
  transitions first, then supplying any fields its transition screen demands.
- The role map keys on state *names*. Linear scopes workflow states per team and does not guarantee
  a stable `type` vocabulary, so the map has to key on state IDs and carry scope.

This gate also moves Baron's central promise from convention into code. Recipes are meant to be
enforced by the engine rather than by the agent's good behaviour, but the MCP server currently
exposes every mutating primitive alongside `baron_recipe_run`. Mutations will require a run token
issued by the recipe engine — which is exactly the explicit-handle pattern the 2026-07-28 MCP
specification settled on after removing sessions.

## What Baron will not do

Scope discipline is a feature. These are decided, not pending:

- **Agent orchestration.** Worktree isolation, parallel agent scheduling, and session supervision
  belong to the harness. Baron sits underneath it and stays there.
- **A memory engine.** Semantic search, embeddings, and decay are a solved and well-funded problem
  elsewhere. Baron's knowledge loop stays small and will carry work-item provenance instead —
  the one thing a general memory product structurally cannot know.
- **Raw provider proxying.** `baron_native_request` is a labelled last resort and will not grow into
  a general passthrough. A gateway that forwards vendor APIs verbatim forfeits the portability that
  justifies Baron at all.
- **A wider port set for its own sake.** Cost tracking, incident management, and velocity reporting
  are not planned. New ports must earn their place against the contract debt above.

The `docs` port is declared in ARCHITECTURE.md but not implemented, so binding it errors. Rather
than leave a promise outstanding, the declaration is being withdrawn until there is a reason to
build it.

## How to influence this

Open an issue. Reports from someone running Baron against a provider it has not been proven on are
worth more than any item on this list, and they will reorder it.
