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

Gate 1 is done. What is left is the distance between "works when its author runs it" and "installs
next to the servers it is meant to sit above", plus two contract defects that only a provider Baron
has no adapter for can settle.

## Gate 1 — Foundation and message — **done**

The contributor and licensing groundwork is in place, the README describes what Baron actually does,
and Baron runs on Baron: this repository's issues, branches and pull requests go through its own
GitHub adapter, with the role labels (`in-progress`, `in-review`, `done`) mapped exactly as
`exampleGithubRoleMap` describes.

Dogfooding here is a test, not a feature pipeline. When Baron hits a gap while running this
repository, that gap is filed — it does not become a reason to grow the surface.

It paid immediately, and the list is the point rather than a footnote: `baron doctor` reported a
sound installation for a token that could not write; no recipe with more than one `ask` could be
driven from a pipe, which is how CI and an agent drive them; `task-land` merged a pull request whose
checks were failing and turned this repository's own main red; `baron init` was still proposing a
type map that left items with no canonical branch. None of that was visible from the test suite, and
none of it survived two hours of actually using the thing.

## Gate 2 — Installability and reach — **done**

Baron published 36 MCP tools against Cursor's cap of 40 per session, so it consumed most of a user's
budget and could not be installed next to the provider MCP servers it is meant to sit above — the
opposite of the point.

Consolidating by **verb** rather than by endpoint settled it: **14 published tools** with every port
bound, **10** on a typical issues+scm install. Measurement changed the plan on the way: a small
default toolset was tried first and abandoned, because the shipped skills legitimately need provider
writes and hiding them would have broken the install rather than slimmed it. `policy.json` still
does the other half — it already knows which ports are bound, so tools for unbound ports are never
published at all.

Alongside it: a short demo that shows one recipe moving a work item and opening a pull request, and
registration on the surfaces where MCP servers are actually discovered.

## Gate 3 — Contract debt and first users

Defects in the role contract are fixed here while the cost of changing them is still near zero.

Three have shipped:

- `blocked` was a member of `WORKFLOW_ROLES`, so transitioning to it destroyed the previous role and
  unblocking had nowhere to return to. It is now an orthogonal flag (`issue.block` / `issue.unblock`)
  that coexists with whatever role an item holds, the way Jira, Linear and GitLab all model it. A
  policy that still maps it is migrated on load and told so.
- The role map keyed on state *names*, which Linear cannot honour: it scopes workflow states per
  team, so two teams each own an "In Progress" that are different rows, and its `type` vocabulary is
  open — the live API returns values no published list contains. The map now keys on whatever a
  provider says identifies its states, and carries scope: one target per team, resolved against the
  team the item is actually in. A scope the map does not know is an error, never a fall back to the
  unscoped default, because that default belongs to no team.
- Baron's central promise moved from convention into code. Recipes are meant to be enforced by the
  engine rather than by the agent's good behaviour, but the MCP server exposed every mutating
  primitive alongside `baron_recipe_run` — a claim anyone reading the tool list could disprove.
  `policy.mutations.channel: "recipe-only"` now refuses a direct provider mutation with
  `MUTATION_OUTSIDE_RECIPE` and names the recipe to use instead. The tools stay listed: hiding them
  would trade an enforceable rule for an obscured one.

The fourth was shaped by a provider Baron has no adapter for yet, and is now also in:

- `applyTarget` assumed a state can be set directly. Jira cannot: you discover the transitions its
  workflow permits from the issue's current state, perform one, and answer whatever fields its
  transition screen demands. The contract now lets a transport report both halves — the reachable
  targets, and the fields a move needs — and the core verifies against them *before* writing: a
  move the provider will not make fails with `TRANSITION_NOT_PERMITTED` naming what it would, a
  move that wants fields fails with `TRANSITION_FIELDS_REQUIRED` naming every one (with accepted
  values), and the caller passes them back as `fields`. The core checks presence and nothing else;
  what a field means stays the provider's. Both halves are pinned by conformance against an
  in-memory provider that refuses the way Jira does. The Jira adapter is built on it — the first
  consumer of both halves — and both halves were proven live on a real site: a team-managed project
  for the everyday path, and a company-managed one on the classic `jira` workflow for the screen
  and the refused hop.

Gate 3's contract work is done. What remains of the gate is its second half: first users. The
closest thing to one so far is the user-journey pass run before each release — the whole path from
`init` to `task-land`, driven by the CLI, the MCP server, a headless Claude Code session with the
plugin skills, and the Docker image, on a fresh project against real providers — which is how
0.38.0's four last defects were found. A stranger's project is still the test that counts.

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

The `docs` port (Notion, Confluence) is declared in ARCHITECTURE.md and remains unimplemented.
Binding it fails with an explicit, actionable error rather than degrading quietly, which is the
behaviour the capability-gap rule asks for — so it stays declared and stays unbuilt. It is not on
this roadmap and will not be until something depends on it.

## How to influence this

Open an issue. Reports from someone running Baron against a provider it has not been proven on are
worth more than any item on this list, and they will reorder it.
