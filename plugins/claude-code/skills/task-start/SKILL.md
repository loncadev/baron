---
name: task-start
description: >-
  Start a task with Baron — create the issue, branch for it, and move it to in_progress as ONE
  deterministic workflow. Use when the user asks to start, begin, or pick up work on a new task or
  feature.
---

# Start a task

Run the **task-start** recipe as a single deterministic call. Do **not** perform the steps yourself
(create issue → branch → transition → comment) — the Baron engine enforces their order and the
role/branch rules. Your job is only to gather the inputs and make one call.

## Inputs

- `title` — the task title (required).

If you are unsure what the recipe needs, call `baron_recipe_list` and read `task-start`'s `inputs`.

## Run it

Call `baron_recipe_run` exactly once:

```json
{ "name": "task-start", "inputs": { "title": "<the task title>" } }
```

## Rules

- Take `title` from the user's request. Ask only if it is genuinely absent — never invent one.
- Call `baron_recipe_run` **once**. Do NOT also call `baron_issue_create` / `baron_scm_branch_create`
  yourself; that duplicates what the recipe already does.
- If the result is an `isError` carrying a code (`RECIPE_INPUT_MISSING`, `ROLE_MAPPING`,
  `CAPABILITY_GAP`, …), surface the code and its actionable hint and stop — do not retry blindly.
- On success, report the issue key, the branch, and the issue's new role from the returned context.
