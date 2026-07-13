---
name: task-start
description: >-
  Start work on an EXISTING work item with Baron — load it, cut its canonical branch, move it to
  in_progress, and sync the local checkout. Use when the user says to start/pick up/resume a known
  task, bug, or story (by id, key, or URL). To create a new item first, use task-new.
argument-hint: <issue-id>
---

# Start a task (existing work item)

Run the **task-start** recipe as ONE deterministic call, then sync the local working tree. The
engine enforces the provider-side order (load → branch → in_progress → comment); your job is the
inputs, the local git, and the briefing.

## Steps

1. **Resolve the issue id** from the user's words (`123`, `AB#123`, or a work-item URL → extract the
   integer). Ask only if genuinely absent.
2. **Preflight local git** (local git is YOUR job, not Baron's): run `git status --porcelain` — if
   dirty, stop and ask the user to commit/stash first. Never start work on a dirty tree.
3. **Run the recipe** — call `baron_recipe_run` exactly once:

   ```json
   { "name": "task-start", "inputs": { "issueId": "<id>" } }
   ```

   The engine loads the item, creates the **canonical branch** (`<prefix>/<id>-<slug>`, derived by
   Baron's core so every agent picks the same name), moves it to `in_progress`, and comments the
   branch on the item.
4. **Sync the local checkout** to the branch Baron created on the provider:

   ```bash
   git fetch origin && git switch <branch-name-from-the-result>
   ```
5. **Assign if unassigned** (optional but recommended): if the returned issue has no `assignee`,
   call `baron_issue_assign` with the user's provider handle (Azure: email; GitHub: login) — derive
   it from `git config user.email` or ask.
6. **Pull into the active sprint if needed** (sprint providers only): compare the item's `iteration`
   with the active sprint. If it's in a *past* iteration or has none while a sprint is active
   (`baron_issue_iterations` → the one with `current: true`), ask whether to pull it in, and on yes
   call `baron_issue_set_iteration { id, iteration: "@current" }`. If no sprint is current, skip
   silently. (This is the "scope creep" checkpoint — the user opts in by pulling mid-sprint.)
7. **Brief, then get to work — do not pause for permission.** Print a one-line briefing (key, title,
   old→new role, branch, url) and immediately continue into the implementation the user asked for.
   "Start task X" means *start it* — the branch is cut and the card is `in_progress`, so begin the
   actual work. Only stop if a real blocker forces a decision (see below); otherwise a "shall I
   continue?" prompt here is exactly the friction to avoid.

## Rules

- **Auto-proceed after starting.** Once the recipe succeeds and the checkout is on the branch, keep
  going into the work without a confirmation turn. Pause only when something genuinely needs the
  user: a dirty tree (step 2), a missing/ambiguous id, a `RECIPE_*`/`ROLE_MAPPING`/branch error, or
  a real implementation fork you can't resolve. "Nothing to decide" ⇒ don't ask, just work.
- Call `baron_recipe_run` **once**. Do NOT hand-compose `baron_issue_get`/`baron_scm_branch_create`.
- A failure carrying `RECIPE_INPUT_MISSING` / `ROLE_MAPPING` / branch-name errors: surface the code
  and stop. In particular, an epic/initiative has **no branch name by design** — ask the user for a
  child story/task/bug instead of inventing a branch.
- If the branch already exists on the provider (create fails saying so), this is a RESUME: skip to
  step 4 (fetch + switch) and continue — do not create `-v2` variants without asking.
- Re-running on an item already `in_progress` is safe (transition is idempotent).
