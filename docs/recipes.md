# Recipes

A recipe is a declarative YAML workflow over Baron's primitives. The engine is pure mechanism —
all the *opinion* (which steps, in what order) lives in the recipe, editable without touching code.

## Running a recipe

A recipe runs as **one deterministic, rule-enforced call** — the engine enforces the step order, not
the caller. Three surfaces, same engine:

- **CLI** — [`baron run --recipe <name-or-path>`](./cli.md#baron-run). `ask` steps prompt on stdin.
- **MCP** — [`baron_recipe_run`](./mcp.md#tools) `{ name, inputs }` runs a recipe by name
  (built-ins: `task-new`, `task-start`, `task-move`, `task-finish`, `task-land`, `ship`; project
  recipes live in `.baron/recipes/*.yaml`).
  Inputs are supplied **up front** in `inputs`; a missing required input fails with
  `RECIPE_INPUT_MISSING` rather than prompting. `baron_recipe_list` reports each recipe's `inputs`.
- **Claude Code skills** — `/baron:task-start`, `/baron:task-finish`, `/baron:task-land`, `/baron:ship`, and
  `/baron:run-recipe` (for any other recipe). Each gathers the inputs and makes the single
  `baron_recipe_run` call; also discoverable by natural language.

## When a run fails halfway

`ship` and `task-finish` mutate several providers in sequence. If the third step fails — CI refuses
the trigger, the network drops — the first two have already happened, and running the recipe again
from the top would do them again: the concrete case is a **second pull request**.

So every run is **journaled**. `.baron/runs/<runId>.jsonl` (gitignored; `init` adds it) gets one
line per event: the inputs the run started with, each `ask` answer, each `do` step with an
idempotency key and the result it bound, each message, and the error or the end. The run id is
reported on success (`Run id: …` on the CLI, `runId` in the MCP context) and on failure (the CLI
prints the resume command; the MCP error carries `details.run = { id, step, op }`).

**Resuming** — `baron run --resume <runId>` or `baron_recipe_run { resume: "<runId>" }` — restores
the inputs and answers from the journal (nothing is asked again), **replays** every completed `do`
step from its journaled result instead of executing it, and carries on from the step that failed.
Each replay is said out loud in the messages (`Replayed scm.pr.create from run …`), and the result
reports how many steps were replayed.

What decides "already done" is the step's key: the run, the step's position (inside a `for_each`,
per element), its op, and its **fully interpolated parameters**. A step whose parameters would now
differ gets a new key and runs — a result produced under other conditions is never reused.

Three refusals, all loud: `RUN_NOT_FOUND` (no journal for that id, or the run already finished),
`RUN_RECIPE_CHANGED` (the recipe's steps are not what the run started with — replaying results
against different instructions is worse than starting over), `RUN_JOURNAL_CORRUPT` (a line that
cannot be read). A journal is append-only: a crash while writing loses at most its last line, which
means at worst one completed step runs twice — never the whole run.

Not covered yet: **compensation**. A run that cannot be completed stays half-done; undoing what it
did (`undo:` on a mutating step) is deferred until a real failure gives it a shape.

## Anatomy

```yaml
name: task-start
description: Create a task, branch for it, and move it into progress.
steps:
  - ask: { as: title, type: text, message: "Task title?" }
  - do: issue.create
    as: issue
    with:
      title: ${title}
      typeRole: task
  - do: scm.branch.create
    as: branch
    with:
      name: feature/${issue.id}
      # fromBranch omitted → defaults to the repo's default branch, so the recipe stays portable
  - do: issue.transition
    as: issue
    with:
      id: ${issue.id}
      role: in_progress
  - message: "Task ${issue.key} is in progress on ${branch.name}."
```

- **`name`** (required), **`description`** (optional).
- **`steps`** — a non-empty list. Each step is exactly one of `ask`, `do`, or `message` (a step with
  more than one — or none — is rejected at parse time).

## Step kinds

### `ask` — gather typed input

```yaml
- ask: { as: branch, type: text, message: "Source branch?", optional: true }
- ask: { as: confirmDelete, type: confirm, message: "Delete the branch?" }
- ask: { as: env, type: choice, message: "Target env?", choices: [dev, prod] }
```

`as` binds the answer into the run context. Types: `text` (string; `optional: true` may yield
nothing), `confirm` (boolean), `choice` (one of `choices`). An `ask` whose variable is already set
(e.g. pre-seeded by the caller) is skipped.

### `do` — invoke a primitive

```yaml
- do: issue.create
  as: issue          # bind the result into the context (optional)
  with: { title: ${title}, typeRole: task }
```

`do` is one of the op names below; `with` holds the (interpolated) parameters; `as` binds the
result. A failing primitive aborts the run with its actionable error.

### `message` — report progress

```yaml
- message: "Opened PR ${pr.url}."
```

### `require` — engine-enforced guard

```yaml
- require:
    truthy: "${issue.branchName}"
    message: "${issue.key} has no canonical branch — pick a child story/task/bug."
- require:
    notEquals: ["${issue.role}", "done"]
    message: "${issue.key} is already done."
```

When the condition is false the run **stops** with the (interpolated) message
(`RECIPE_REQUIRE`) — a failed guard never falls through to the mutation steps below it. The rules
live in the engine, not in agent judgement (decision #19). Conditions (exactly one per guard):
`truthy: <value>` / `falsy: <value>` (present vs absent/''/false/null) and
`equals: [a, b]` / `notEquals: [a, b]` (interpolated string comparison). Deliberately not an
expression language.

### `for_each` — run steps once per element

```yaml
  - for_each: ${items}          # must resolve to a list; anything else is an error, not an empty run
    as: item                     # the element, bound for one iteration
    collect: { as: moved, from: "${done.key}" }   # optional: one value per iteration, bound after
    steps:
      - do: issue.transition
        as: done
        with: { id: "${item.id}", role: in_review }
```

The rest of the grammar is single-shot, which is why the one workflow Baron ships that *sweeps* had
to live as prose in a skill — and on an install that sets `mutations.channel` to `recipe-only` that
prose cannot run at all, since every fix it prescribes is refused and the refusal points at a recipe
that did not exist.

Three rules, each of them a footgun closed rather than a preference:

- **Bindings made inside an iteration do not leak.** Reading `${done}` after the loop gets nothing,
  not whichever element happened to be last — a value that is real, just never the one meant.
- **`collect` binds an array even when nothing matched**, so a recipe can report "0 items" instead of
  interpolating a reference that resolves to nothing. Iterations whose expression resolves to nothing
  contribute nothing, so "the ones that matched" needs no second concept.
- **No `ask` inside a loop, and no loop inside a loop.** Asks are hoisted by `baron_recipe_list` so a
  caller can supply them upfront — that is what makes a recipe runnable in one shot — and an ask in a
  loop is both invisible to that and asked once per element. Nesting is refused because one level
  covers every sweep here, and it is easier to allow later than to take back.

### `when:` — conditional do/message steps

```yaml
- do: scm.pr.find
  as: existingPr
  with:
    sourceBranch: ${branch}
- do: scm.pr.create
  as: pr
  when:
    falsy: "${existingPr}"
  with: { title: "${title}", sourceBranch: "${branch}" }
- message: "PR already open: ${existingPr.url}"
  when:
    truthy: "${existingPr}"
```

A `when:` (same condition shapes) skips the step when false — the skipped step's `as` stays unset.
This is how `task-finish` is idempotent **in the engine**: find-then-create-or-report.

## Interpolation

String values may contain `${path}` references into the run context (seeded inputs + each step's
`as`). A value that is **exactly** one reference keeps the resolved type (so an optional
`parentId: ${parent}` becomes truly unset, not the literal `"undefined"`); embedded references render
to text.

> **YAML gotcha:** inside a *flow* map, quote references — `with: { id: "${issue.id}" }` — or use
> block style. Unquoted `${…}` in a flow map is a YAML parse error, not a Baron limitation.

## Op reference

| `do:` | Params (`with`) | Result bound by `as` |
| --- | --- | --- |
| `issue.create` | `title`, `typeRole`, `body?`, `parentId?`, `labels?`, `initialRole?` | the issue |
| `issue.get` | `id` | the issue (incl. `branchName`, the canonical `<prefix>/<id>-<slug>`) |
| `issue.transition` | `id`, `role`, optional `fields` (answers for a gated provider's transition screen, keyed by its native field names) | the issue |
| `issue.classify` | `id`, `role` | `{ kind: advance \| regress \| reopen \| noop, from, to }` — judge a move BEFORE making it |
| `issue.reconcile` | `id` | the issue, with any role label Baron itself wrote cleared once the provider's own state contradicts it |
| `issue.update` | `id`, `title?`, `body?` | the issue |
| `issue.comment` | `id`, `body` | the comment |
| `issue.link` | `fromId`, `toId`, `type` | — |
| `issue.assign` | `id`, `assignee` (provider-native handle) | the issue |
| `issue.block` | `id`, `reason` | the issue — sets the orthogonal blocked flag; the role is untouched. A reason is required |
| `issue.unblock` | `id`, `reason?` | the issue — clears the flag, leaving the role where the work actually was |
| `issue.whoami` | — | the authenticated user's provider-native handle |
| `issue.iterations` | — | iteration list (each with a `current` flag) |
| `issue.set-iteration` | `id`, `iteration` (path or `@current`) | the issue |
| `issue.query` | `role?`, `typeRole?`, `assignee?` (handle or `@me`), `iteration?` (path or `@current`), `limit?` | issue list |
| `scm.branch.create` | `name`, `fromBranch?` | the branch |
| `scm.pr.create` | `title`, `sourceBranch`, `targetBranch?`, `body?`, `draft?` | the PR |
| `scm.pr.thread` | `pullRequestId`, `body` | the thread |
| `scm.pr.status` | `pullRequestId` | normalized PR status (state, reviewDecision, mergeable, checks) |
| `scm.pr.find` | `sourceBranch`, `state?` (`open` default / `merged` / `closed` / `all`) | the most recent matching PR (with `state`), or `null` |
| `scm.pr.ready` | `pullRequestId` | the PR, taken out of draft |
| `scm.pr.merge` | `pullRequestId`, `strategy?`, `deleteSourceBranch?` | `{ merged, sha }` — throws if the provider refuses |
| `ci.run.trigger` | `pipelineId`, `ref?`, `variables?` | the triggered run |
| `ci.run.cancel` | `runId` | the canceled run |
| `deploy.deployments` | `environment?`, `limit?` | deployment list |
| `notify.send` | `text`, `channel?`, `threadKey?` | the sent message |
| `learning.append` | `title`, `body`, `tags?` | the learning |
| `learning.query` | `tag?`, `text?`, `limit?` | learning list |
| `followup.append` | `title`, `body?`, `tags?` | the follow-up |
| `followup.list` | `status?`, `tag?`, `limit?` | follow-up list |

`role`/`typeRole`/`type`/`status` values are validated against the abstract enums (see
[Concepts](./concepts.md#2-semantic-roles)); a bad value fails the step loudly. A `do` whose port
isn't configured fails with `PORT_UNBOUND`.

## Built-in recipes

The recipes in `packages/recipes/recipes/` all run **by name** — over MCP (`baron_recipe_run`, the
recipe skills) and on the command line (`baron run --recipe task-start`) alike — as well as by path. They mirror the reference flow Baron was
abstracted from (ARCHITECTURE #21): creating and starting are separate acts, and opening a PR does
NOT move the role — what happens at merge belongs to the provider (a provider that closes the linked
item on merge lands it in `done`; elsewhere `task-move` / `task-sync` settles it).

- `task-new` — CREATE a work item (title + type role + optional parent).
- `task-start` — start an EXISTING item: load it, branch on its core-derived canonical
  `branchName` (`<prefix>/<id>-<slug>`; fails loudly for epics), move to `in_progress`, note the
  branch on the item. The branch is cut **on the provider**; the engine drives ports, never your
  local git, so your working copy does not move and you check the branch out yourself. The recipe
  prints the command — commit before doing so and the commit lands on your default branch.
- `task-finish` — open a draft PR + post the link on the item. Deliberately does NOT move the role.
- `task-land` — undraft (only if it is a draft) + merge the item's PR. Refuses when there is no open
  PR; a provider that declines the merge surfaces as `MERGE_FAILED` instead of a reported success.
  It does not transition the item either: a native closing link (GitHub `Closes #N`) already closes
  it on merge, and where it doesn't (Azure), `task-move` settles it.
- `task-sync-report` — sweep in-flight items for drift between their role and their branch's PR, and
  report it. **Read-only**, so it runs on an installation that routes every mutation through recipes.
  Two findings: an item still `in_progress` whose branch has a MERGED pull request (the common one —
  most trackers cannot advance an item when its PR merges), and an item `in_review` whose branch has
  no pull request at all. The first is applied with `task-move`, one item at a time, after a human
  agrees; the second is reported and never acted on, because a wrong branch, a force-push and a
  hand-moved card all look identical and want different answers.
- `task-reconcile` — clear a role label the provider's own state contradicts: an item the provider
  closed while a stale label keeps it showing as in-flight. It commands no role — it reads what the
  provider says and removes what disagrees — and refuses on an item the provider has not closed,
  because on a provider where closing does not mean `done`, commanding `done` invents a fact.
- `ship` — a multi-port example: draft PR (`scm`) + `in_review` (`issues`) + CI trigger (`ci`) +
  notify (`notify`) in one run.

Built-ins run by name with no file at all; to adapt one, copy it out of the
`@lonca/baron-recipes` package (or this repository's `packages/recipes/recipes/`) into `.baron/recipes/` as a starting point for your own; project recipes there are
runnable by name too.
