---
# Symphony reads and schedules; Baron writes. Symphony's own spec draws this line in §11.5
# ("Tracker Writes and Agent Tools"): the orchestrator does not require tracker write APIs, and
# ticket mutations are left to the coding agent's provider-native tools. Those raw tools are where
# an agent guesses a vendor's state machine wrong, so this workflow routes them through Baron.
#
# Fill `kind`, `provider`, and the state lists from your tracker — these are provider-NATIVE names
# and Symphony's adapter owns their defaults. Keep them consistent with the role map you confirmed
# at `baron init`: Symphony reads native states, Baron writes roles, and `.baron/policy.json` is
# what makes those two agree.
tracker:
  kind: github
  provider:
    owner: your-org
    repo: your-repo
  required_labels: []
  # Native state names, NOT Baron roles. With Baron's GitHub role map these correspond to
  # in_progress -> "in-progress" and in_review -> "in-review".
  active_states:
    - in-progress
    - in-review
  terminal_states:
    - done
polling:
  interval_ms: 30000
workspace:
  root: ~/code/symphony-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/your-org/your-repo .
    # Baron reads .baron/policy.json from the repo (committed) and credentials from the
    # environment (never committed), so a fresh workspace needs no extra setup.
agent:
  max_concurrent_agents: 4
  max_turns: 20
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
---

# Workflow

You are working a single issue to completion. Symphony has already claimed it and prepared this
workspace; your job is the code and the bookkeeping around it.

## Prerequisite: the Baron MCP server is available

Every change to the work item goes through Baron — `baron_recipe_run` for whole workflows, or the
`baron_issue_*` / `baron_scm_*` primitives when no recipe fits.

If the Baron tools are not present, treat that as blocked access: say so in your workpad comment and
stop. Do not fall back to raw provider API calls, and do not ask a human to configure it mid-run.

## Speak roles, not native states

Baron's vocabulary is `backlog → ready → in_progress → in_review → done`, plus `blocked`. Item types
are roles too: `initiative`, `epic`, `story`, `task`, `bug`, `subtask`.

Never write a provider-native state name. Say *"move it to in_progress"* and let Baron map that to
whatever this provider actually uses — a label on GitHub, `Active` on Azure DevOps. The mapping was
confirmed by a human at `baron init` and lives in `.baron/policy.json`; it is not yours to guess or
override.

The practical consequence: this file does not change when the tracker changes. Only the front matter
above does.

## Flow

1. **Read the item.** `baron_issue_read { op: "get" }` with the id Symphony dispatched.

2. **Start it.** Run the `task-start` recipe rather than composing the steps yourself. It loads the
   item, refuses to proceed if it is already done or assigned to someone else, cuts the canonical
   branch, moves the role to `in_progress`, assigns you, and comments once. Those guards run *before*
   anything is mutated, which is the point of using the recipe.

3. **Use Baron's branch name verbatim.** It is derived from the item's type role, so every agent and
   every recipe derives the same name for the same item. Never assemble one yourself. Containers
   (`epic`, `initiative`) have no branch by design — if you were handed one, stop and say so.

4. **Do the work.** Ordinary implementation: read, edit, test. Reading the provider natively is fine;
   *changing* the work item is not.

5. **Open the pull request.** Run `task-finish`. Note that it deliberately does **not** move the role
   to `done` — what a merge means is the provider's rule, not Baron's. A provider whose native PR
   link closes the item on merge will land it in `done` on its own; one that only mentions the item
   will not, and `task-move` or `task-sync` settles it afterwards.

6. **Handle review feedback.** Treat every actionable reviewer comment, human or bot, as blocking
   until the code changes or you post a justified reply. Record each item and its resolution in the
   workpad comment via `baron_issue_write { op: "comment" }`.

7. **Land it.** Run `task-land`. Do not call `gh pr merge` directly.

## When Baron says a capability is missing

Baron negotiates gaps explicitly — it errors, emulates the capability (hierarchy via labels, for
example), or degrades with a warning, according to the policy in `.baron/policy.json`.

An emulated result, or an empty result from a degraded capability, is **expected behaviour**. Do not
report it as a failure and do not work around it with a raw API call. If Baron errors on a gap, that
is a deliberate signal that this provider cannot do what was asked: record it and move the item
according to the flow above.

## Guardrails

- No raw provider API calls for work-item changes. If you find yourself reaching for one, the answer
  is either a Baron primitive or a genuine capability gap worth reporting.
- No inventing branch names, no inventing native state names.
- One item per run. Do not touch other items, and do not create new ones unless the flow says to.
- If the item's state and its content disagree, add a short comment saying so and take the safest
  path rather than guessing.
