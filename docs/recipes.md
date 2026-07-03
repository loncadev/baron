# Recipes

A recipe is a declarative YAML workflow over Baron's primitives. The engine is pure mechanism —
all the *opinion* (which steps, in what order) lives in the recipe, editable without touching code.

## Running a recipe

A recipe runs as **one deterministic, rule-enforced call** — the engine enforces the step order, not
the caller. Three surfaces, same engine:

- **CLI** — [`baron run --recipe <path>`](./cli.md#baron-run). `ask` steps prompt on stdin.
- **MCP** — [`baron_recipe_run`](./mcp.md#tools) `{ name, inputs }` runs a recipe by name
  (built-ins: `task-start`, `task-finish`, `ship`; project recipes live in `.baron/recipes/*.yaml`).
  Inputs are supplied **up front** in `inputs`; a missing required input fails with
  `RECIPE_INPUT_MISSING` rather than prompting. `baron_recipe_list` reports each recipe's `inputs`.
- **Claude Code skills** — `/baron:task-start`, `/baron:task-finish`, `/baron:ship`, and
  `/baron:run-recipe` (for any other recipe). Each gathers the inputs and makes the single
  `baron_recipe_run` call; also discoverable by natural language.

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
| `issue.transition` | `id`, `role` | the issue |
| `issue.comment` | `id`, `body` | the comment |
| `issue.link` | `fromId`, `toId`, `type` | — |
| `issue.assign` | `id`, `assignee` (provider-native handle) | the issue |
| `issue.query` | `role?`, `typeRole?`, `assignee?` (handle or `@me`), `limit?` | issue list |
| `scm.branch.create` | `name`, `fromBranch?` | the branch |
| `scm.pr.create` | `title`, `sourceBranch`, `targetBranch?`, `body?`, `draft?` | the PR |
| `scm.pr.thread` | `pullRequestId`, `body` | the thread |
| `scm.pr.status` | `pullRequestId` | normalized PR status (state, reviewDecision, mergeable, checks) |
| `scm.pr.find` | `sourceBranch`, `state?` (`open` default / `merged` / `closed` / `all`) | the most recent matching PR (with `state`), or `null` |
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

`packages/recipes/recipes/` ships four recipes, all runnable **by name** (`baron_recipe_run`, the
recipe skills) as well as by path (`baron run --recipe`). They mirror the reference flow Baron was
abstracted from (ARCHITECTURE #21): creating and starting are separate acts, and review state moves
on merge, not at PR-open.

- `task-new` — CREATE a work item (title + type role + optional parent).
- `task-start` — start an EXISTING item: load it, branch on its core-derived canonical
  `branchName` (`<prefix>/<id>-<slug>`; fails loudly for epics), move to `in_progress`, note the
  branch on the item.
- `task-finish` — open a draft PR + post the link on the item. Deliberately does NOT move the role.
- `ship` — a multi-port example: draft PR (`scm`) + `in_review` (`issues`) + CI trigger (`ci`) +
  notify (`notify`) in one run.

Copy any of them into `.baron/recipes/` as a starting point for your own; project recipes there are
runnable by name too.
