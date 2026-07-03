---
name: task-list
description: >-
  List work items with Baron, filtered by role, type, or assignee — "my in-progress work", "open
  bugs", "what's in review". Roles, not vendor states, so the same query works on any provider Baron
  binds. Use when the user asks to list/show/find work items.
argument-hint: "[@me | in_progress | in_review | backlog | bugs | tasks | stories | ...]"
---

# List work items

A thin, read-only wrapper over `baron_issue_query` that maps everyday words to its normalized filters
(`role`, `typeRole`, `assignee`, `limit`). It never mutates anything.

## Token → filter mapping

- **Assignee:** `@me` / "mine" / "bana atanan" → `assignee: "@me"`. A bare handle (email/login) → that
  handle.
- **Role:** `in_progress` / "active" / "devam eden" → `role: "in_progress"`; `in_review` / "test" /
  "review" → `role: "in_review"`; `backlog` / "new" → `role: "backlog"`; `ready` → `role: "ready"`;
  `done` / "closed" → `role: "done"`; `blocked` → `role: "blocked"`.
- **Type:** `bugs` → `typeRole: "bug"`; `tasks` → `task`; `stories` → `story`; `epics` → `epic`.
- **Sprint:** `sprint` / "this sprint" / "aktif sprint" → `iteration: "@current"` (the active sprint);
  a literal iteration path → that iteration. On providers without sprints this yields nothing.

Filters are AND-combined. `baron_issue_query` returns a lightweight projection (no body); default cap
is 50 — pass a higher `limit` only when the user asks for more.

## Steps

1. **Parse** the tokens from the argument (combinable: `@me bugs`, `in_review`, …).
2. **Query.** One `baron_issue_query` call with the mapped filters. `baron_issue_query` takes a single
   `role`, so if the user asks for a set that spans roles (e.g. "my open work" = in_progress +
   in_review), run one query per role and merge. Default with no argument: `assignee: "@me"` across
   the active roles (in_progress + in_review).
3. **Present** a compact table: `key · title · role · typeRole · assignee` (+ the item's `branchName`
   when present — it's the branch you'd resume with `/baron:task-start`). If empty, say so plainly.

## Rules

- Read-only: never transition, comment, or create from this skill — that's `/baron:task-move` /
  `/baron:task-new`.
- Don't dump raw JSON; format the rows. For a large result, show the count and the first page, and
  offer to narrow the filter rather than raising `limit` blindly.
