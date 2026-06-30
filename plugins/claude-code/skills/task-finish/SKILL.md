---
name: task-finish
description: >-
  Finish a task with Baron — open a draft pull request for its branch and move the issue to
  in_review as ONE deterministic workflow. Use when the user says a task is done, ready for review,
  or asks to open a PR for it.
---

# Finish a task

Run the **task-finish** recipe as a single deterministic call. Do **not** open the PR, transition the
issue, and add the thread yourself — the Baron engine enforces the order and the role mapping. Your
job is only to gather the inputs and make one call.

## Inputs

- `issueId` — the issue being finished (required).
- `branch` — the source branch the PR opens from (required).
- `title` — the pull request title (required).

If you are unsure, call `baron_recipe_list` and read `task-finish`'s `inputs`. The PR targets the
repo's default branch automatically — do not ask for a target branch.

## Run it

Call `baron_recipe_run` exactly once:

```json
{ "name": "task-finish", "inputs": { "issueId": "<id>", "branch": "<source branch>", "title": "<PR title>" } }
```

## Rules

- Gather the inputs from context (the issue currently in progress, the working branch). Ask only for
  what is genuinely missing.
- Call `baron_recipe_run` **once**. Do NOT also call `baron_scm_pr_create` / `baron_issue_transition`
  yourself.
- If the result is an `isError` with a code (`RECIPE_INPUT_MISSING`, `CAPABILITY_GAP`, …), surface
  the code and its hint and stop — do not retry blindly.
- On success, report the PR url and that the issue moved to review.
