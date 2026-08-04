---
name: task-finish
description: >-
  Finish a work-item branch with Baron — push it, open (or find) the draft pull request, and post
  the PR link on the item. Use when the user says the work is done / ready for review / open a PR.
  The item's role does NOT move here — it moves when the PR merges.
---

# Finish a task (open the PR)

Idempotent finish: push the branch, check for an existing PR first, and only then run the
**task-finish** recipe as ONE deterministic call. Local git is YOUR job; provider truth is Baron's.

## Steps

1. **Identify the work item + branch**: parse the current branch (`git rev-parse --abbrev-ref HEAD`)
   as `<prefix>/<id>-<slug>` and extract `<id>`. If the branch doesn't match, ask — never open a PR
   from a non-work-item branch without confirming.
2. **Preflight local git**: `git status --porcelain` — dirty tree → stop (commit/stash first). Then
   **push**: `git push -u origin HEAD` (never `--force`; on a non-fast-forward reject, explain the
   rebase path and stop).
3. **Idempotency check** — call `baron_scm_pr_for_branch` with the branch:
   - **PR exists** (non-null): do NOT create another. Report its URL, and add a
     `baron_scm_pr_thread` note only if there is genuinely new context (new commits since).
   - **null**: continue.
4. **Compose the PR description — never open an empty PR.** A reviewer should not have to
   reconstruct the change from the diff. Write it from what you actually have: the work item
   (`baron_issue_get`) plus the real commits/diff on the branch (`git log <base>..HEAD --oneline`,
   `git diff --stat`). Cover, briefly:
   - **What changed** — the substance, not a file list.
   - **Why** — the problem from the item; call out any decision you made along the way.
   - **How it was verified** — tests/build/manual check, and honestly what was NOT verified.

   Keep it short and specific; skip a section that has nothing real to say.

5. **Ask about auto-complete** (`AskUserQuestion`, one question): *"Merge automatically once checks
   pass?"* → **Enable** / **No, I'll merge it myself**. It is the user's call whether a PR lands
   unattended, so ask rather than assume — but ask ONCE and don't belabor it.

6. **Run the recipe** — call `baron_recipe_run` exactly once:

   ```json
   { "name": "task-finish", "inputs": { "issueId": "<id>", "branch": "<branch>", "title": "<PR title>", "body": "<the description you composed>", "autoComplete": true } }
   ```

   The PR is assigned to you automatically (providers without PR assignees negotiate that gap), so
   nobody has to add themselves in the UI afterwards.

   PR title: the top commit's conventional-commit subject (ask only if it reads poorly). The engine
   opens a DRAFT PR **linked to the work item** (the adapter renders the provider's native keyword —
   GitHub `Closes #N`, Azure `AB#N` — so the tracker really associates them), adds the opening
   thread, and posts the PR link on the work item.
7. **Report**: PR URL + "role unchanged — it moves to in_review when the PR merges" (merge-time is a
   deliberate rule, not an omission). Mention it opened as a **draft**: that is deliberate — you mark
   it ready for review when you want reviewers, and the item moves on merge. If auto-complete was
   requested, report whether it actually took (`autoCompleteEnabled`) — a repo with auto-merge
   disabled refuses it, and that is worth saying out loud rather than assuming it is armed.

## Rules

- **Never open a PR with an empty description.** Compose it (step 4) from the item + the real diff.
- Call `baron_recipe_run` **once**, and only after the null check in step 3.
- Do NOT transition the issue here — not manually either. If the user explicitly asks to move it,
  use `baron_issue_transition` and say why (they own the exception).
- Surface `isError` codes with their hint and stop; never retry blindly.
