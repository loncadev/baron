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
engine enforces the provider-side order (load → branch → in_progress → **assign to you** → comment);
your job is the inputs, the local git, the ownership check, and the briefing.

## Steps

1. **Resolve the issue id** from the user's words (`123`, `AB#123`, or a work-item URL → extract the
   integer). Ask only if genuinely absent.
2. **Preflight local git** (local git is YOUR job, not Baron's): run `git status --porcelain` — if
   dirty, stop and ask the user to commit/stash first. Never start work on a dirty tree.
3. **Ownership check — never silently take over someone else's work.** Read the item first with
   `baron_issue_get { id: "<id>" }` and look at `assignee`:
   - **Unassigned** → proceed to step 4 with no `takeover`.
   - **Assigned to you** (`assignee` matches `git config user.email`, or the GitHub login) → proceed
     with `takeover: true`; this is a claim/resume, no need to ask.
   - **Assigned to someone else** → **ask the user before starting** (AskUserQuestion: "AB#N is
     assigned to `<assignee>`. Take it over and start?" → Take over / Cancel). On *Take over*,
     proceed with `takeover: true`. On *Cancel*, stop — do **not** start. If you cannot tell whose it
     is, treat it as someone else's and ask.

   Starting **assigns the item to you** (the recipe does `issue.assign @me` after moving it to
   `in_progress`), so whoever runs task-start becomes the owner.
4. **Run the recipe** — call `baron_recipe_run` exactly once, passing `takeover` as decided above:

   ```json
   { "name": "task-start", "inputs": { "issueId": "<id>", "takeover": true } }
   ```

   (Omit `takeover` for an unassigned item.) The engine loads the item, creates the **canonical
   branch** (`<prefix>/<id>-<slug>`, derived by Baron's core so every agent picks the same name),
   moves it to `in_progress`, assigns it to you, and comments the branch on the item. If the item is
   assigned and you did not pass `takeover`, the recipe **stops** (`RECIPE_REQUIRE`) — that is the
   engine-level backstop for the ownership rule; go back to step 3 and ask.
5. **Sync the local checkout** to the branch Baron created on the provider:

   ```bash
   git fetch origin && git switch <branch-name-from-the-result>
   ```
6. **Pull into the active sprint if needed** (sprint providers only): compare the item's `iteration`
   with the active sprint. If it's in a *past* iteration or has none while a sprint is active
   (`baron_issue_iterations` → the one with `current: true`), ask whether to pull it in, and on yes
   call `baron_issue_set_iteration { id, iteration: "@current" }`. If no sprint is current, skip
   silently. (This is the "scope creep" checkpoint — the user opts in by pulling mid-sprint.)
7. **Understand the work before coding — read the whole item, not just the title.** Baron's read
   already gives you the `body` (a Bug's repro steps, otherwise the description), type, labels, and
   parent. Gather the rest so you start *informed*, using the provider's read/explore tools:
   - **Comments / discussion** on the item — decisions, gotchas, prior attempts, review feedback.
   - **Attachments** (specs, screenshots, logs, stack traces) — open the ones that look relevant.
   - **Extra native fields the body doesn't carry** — a Bug's *System Info*, *Acceptance Criteria*,
     and any custom fields.

   On Azure use the azure-devops explorer (`wit_get_work_item` with `expand: all`,
   `wit_list_work_item_comments`, attachment fetch); on GitHub read the issue body +
   `issues.listComments`. Then write a one-paragraph summary of what the task actually needs — that
   summary is your starting point, not the title alone.
8. **Brief, then get to work — do not pause for permission.** Print a one-line briefing (key, title,
   old→new role, branch, url) plus the context summary from step 7, and immediately continue into the
   implementation the user asked for. "Start task X" means *start it* — the branch is cut and the card
   is `in_progress`, so begin the actual work. Only stop if a real blocker forces a decision (see
   below); otherwise a "shall I continue?" prompt here is exactly the friction to avoid.

## Rules

- **Ask before taking over someone else's item; never silently reassign.** The one prompt task-start
  is allowed (and required) to make before starting is the step-3 ownership question. An unassigned
  item or one already yours starts without asking.
- **Auto-proceed after starting.** Once the recipe succeeds and the checkout is on the branch, keep
  going into the work without a confirmation turn. Pause only when something genuinely needs the
  user: a dirty tree (step 2), the ownership question (step 3), a missing/ambiguous id, a
  `RECIPE_*`/`ROLE_MAPPING`/branch error, or a real implementation fork you can't resolve. "Nothing
  to decide" ⇒ don't ask, just work.
- Run the **mutation** as one `baron_recipe_run` call — do NOT hand-compose
  `baron_scm_branch_create`/`baron_issue_transition`/`baron_issue_assign`. The only primitive you call
  yourself is the read-only `baron_issue_get` for the step-3 ownership check.
- A failure carrying `RECIPE_INPUT_MISSING` / `ROLE_MAPPING` / branch-name errors: surface the code
  and stop. In particular, an epic/initiative has **no branch name by design** — ask the user for a
  child story/task/bug instead of inventing a branch.
- **Resume is safe and idempotent.** Re-running task-start on an item already started re-cuts
  nothing: `scm.branch.create` returns the existing branch, `in_progress` and the `@me` assignment
  re-assert cleanly. Just fetch + switch to the canonical branch — never invent `-v2` variants.
