# Recipes

A recipe is a declarative YAML workflow over Baron's primitives. The engine is pure mechanism —
all the *opinion* (which steps, in what order) lives in the recipe, editable without touching code.
Run one with [`baron run --recipe <path>`](./cli.md#baron-run).

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
      fromBranch: main
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
| `issue.get` | `id` | the issue |
| `issue.transition` | `id`, `role` | the issue |
| `issue.comment` | `id`, `body` | the comment |
| `issue.link` | `fromId`, `toId`, `type` | — |
| `issue.query` | `role?`, `typeRole?`, `limit?` | issue list |
| `scm.branch.create` | `name`, `fromBranch` | the branch |
| `scm.pr.create` | `title`, `sourceBranch`, `targetBranch`, `body?`, `draft?` | the PR |
| `scm.pr.thread` | `pullRequestId`, `body` | the thread |
| `learning.append` | `title`, `body`, `tags?` | the learning |
| `learning.query` | `tag?`, `text?`, `limit?` | learning list |
| `followup.append` | `title`, `body?`, `tags?` | the follow-up |
| `followup.list` | `status?`, `tag?`, `limit?` | follow-up list |

`role`/`typeRole`/`type`/`status` values are validated against the abstract enums (see
[Concepts](./concepts.md#2-semantic-roles)); a bad value fails the step loudly. A `do` whose port
isn't configured fails with `PORT_UNBOUND`.

## Shipped examples

`packages/recipes/recipes/` ships `task-start.yaml` and `task-finish.yaml`. Copy them as a starting
point.
