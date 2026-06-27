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

Scm port: `baron_scm_branch_create`, `baron_scm_pr_create`, `baron_scm_pr_thread`.

A tool that hits a capability gap returns an `isError` result whose text begins with a stable code
(e.g. `CAPABILITY_GAP`, `ROLE_MAPPING`) — read it and adjust (retry with a different role, drop a
parent, or tell the human to widen the gap policy) rather than treating it as a hard stop.

## Recipes

Multi-step workflows live in declarative YAML recipes (see `@baron/recipes`, e.g. `task-start`,
`task-finish`). Run one with the CLI: `baron run --recipe <path>`. Prefer a recipe when the user
describes a whole flow ("start a task", "open a PR and move it to review"); use individual MCP tools
for one-off actions.

## Prerequisites

- A committed `.baron/policy.json` (created by `baron init`).
- Credentials in the environment / `.baron/credentials` (never committed): e.g.
  `GITHUB_OWNER/REPO/TOKEN` or `AZURE_DEVOPS_ORG/PROJECT/REPO/TOKEN`.
