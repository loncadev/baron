---
name: baron
description: >-
  Drive work tracking (issues) and source control (pull requests) through Baron's provider-agnostic
  ports. Use when the user asks to create/transition/comment/link/query issues, open branches or
  pull requests, or run a Baron recipe — across Azure DevOps, GitHub, or whatever the repo's
  .baron/policy.json binds.
user-invocable: true
---

# Baron

Baron normalizes work orchestration so you speak **abstract roles**, not vendor states. The active
providers are whatever `.baron/policy.json` binds (run `baron init` first if it is missing).

## Vocabulary (never use provider-native states)

- Workflow roles: `backlog → ready → in_progress → in_review → done`, plus `blocked`.
- Type roles: `initiative`, `epic`, `story`, `task`, `subtask`.
- Link types: `relates`, `blocks`, `blocked_by`, `duplicates`.

Baron translates these to each provider's native states/types/links and negotiates capability gaps
(emulate / degrade / error) — you never hardcode an Azure state or a GitHub label.

## MCP tools (this plugin registers the `baron` MCP server)

Issues port: `baron_issue_create`, `baron_issue_get`, `baron_issue_transition`,
`baron_issue_comment`, `baron_issue_link`, `baron_issue_query`.

Scm port: `baron_scm_branch_create`, `baron_scm_pr_create`, `baron_scm_pr_thread`,
`baron_scm_pr_status`. `branch_create`/`pr_create` default the base branch to the repo default when
omitted. `pr_status` returns a normalized `PullRequestStatus`: `state`
(`open|merged|closed|unknown`), `reviewDecision`
(`approved|changes_requested|review_required|pending|unknown`), `mergeable`, and a `checks` rollup
(`succeeded|failed|pending|none`) — reach for it to gate "is this PR ready to merge?".

Ci / pipelines port: `baron_ci_pipelines`, `baron_ci_runs`, `baron_ci_run_get`,
`baron_ci_run_logs`, `baron_ci_run_trigger`, `baron_ci_run_cancel`. Run state is the normalized
`RunStatus` = `queued|running|succeeded|failed|canceled|skipped|waiting|unknown` (collapsed from each
provider's native phase + result; per-stage status appears in `run_get`; `run_logs` is a size-aware
tail). `runs` defaults `limit` 50. Use these to list/trigger/cancel CI and inspect why a run failed.

Deploy / environments port: `baron_deploy_environments`, `baron_deploy_deployments`. Deployment
state is the normalized `DeployStatus` = `pending|running|succeeded|failed|canceled|skipped|unknown`.
Use these to see environments and what's deployed where.

Notify port: `baron_notify_send` (`text`, optional `channel`, optional `threadKey` for threaded
replies). Use to ping a human or post status to Slack.

Escape hatch (LAST RESORT, non-portable): `baron_native_request` makes a raw authenticated provider
REST call and only reaches providers the policy binds. Prefer the normalized tools above; reach for
this only when no port covers what you need, and expect the result to be vendor-specific.

A tool that hits a capability gap returns an `isError` result whose text begins with a stable code
(e.g. `CAPABILITY_GAP`, `ROLE_MAPPING`) — read it and adjust (retry with a different role, drop a
parent, or tell the human to widen the gap policy) rather than treating it as a hard stop.

## Recipes (packaged workflows)

Multi-step workflows are **declarative recipes** run as ONE deterministic, rule-enforced call — the
engine enforces the step order, you don't. Prefer a recipe whenever the user describes a whole flow
("start a task", "open a PR and move it to review", "ship this"); use the individual MCP tools only
for one-off actions, and never hand-compose the primitives to emulate a recipe.

- `baron_recipe_list` — discover the runnable recipes and the `inputs` each declares.
- `baron_recipe_run` `{ name, inputs }` — run one end-to-end. Required inputs are validated up front
  (`RECIPE_INPUT_MISSING`); it never prompts. Built-ins: `task-start`, `task-finish`, `ship`. Project
  recipes live in `.baron/recipes/*.yaml`.

Dedicated skills wrap the built-ins — `/baron:task-start`, `/baron:task-finish`, `/baron:ship` (and
`/baron:run-recipe` for anything else): each gathers the inputs and makes the single
`baron_recipe_run` call. (`baron run --recipe <path>` runs the same recipes from the CLI.)

## Prerequisites

- A committed `.baron/policy.json` (created by `baron init`).
- Credentials in the environment / `.baron/credentials` (never committed): e.g.
  `GITHUB_OWNER/REPO/TOKEN` or `AZURE_DEVOPS_ORG/PROJECT/REPO/TOKEN`.
