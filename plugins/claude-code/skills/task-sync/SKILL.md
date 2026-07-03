---
name: task-sync
description: >-
  Sweep in-flight work items for drift between their workflow role and their branch's PR reality —
  the classic "the PR merged but the card is still in progress" — and batch-fix it with Baron. Use
  when the user asks to sync/reconcile the board, tidy stale cards, or "what's still in progress but
  actually done?".
argument-hint: "[@me | all]"
---

# Sync the board with PR reality

Trackers often can't auto-advance a work item when its PR merges, so cards rot in the wrong state.
This skill detects that drift **from facts, not guesses** — every fact comes from a Baron primitive —
and offers a batch fix. It works on any provider Baron binds (Azure DevOps, GitHub), because it reads
normalized roles and PR state, not vendor columns.

## The drift rule (fixed — you apply it, you don't judge it)

For each in-flight item, correlate it to its branch's PR via the **core-derived `branchName`**:

- **A — merged-but-stuck** (the common one): role is `in_progress` AND its branch has a **merged** PR
  → should be `in_review`. Auto-fixable.
- **B — in-review-without-a-PR** (rare): role is `in_review` AND its branch has **no** PR at all
  → flag for the human; do NOT auto-change (something is off — wrong branch, force-push, manual move).

## Steps

1. **Scope.** Default to the current user's items (`@me`); `all` sweeps everyone. Query the two
   candidate sets:
   - `baron_issue_query { role: "in_progress", assignee: "@me" }`  (drop `assignee` for `all`)
   - `baron_issue_query { role: "in_review", assignee: "@me" }`
2. **Correlate each candidate** (skip any with no `branchName` — containers never have one):
   - Scenario A: `baron_scm_pr_for_branch { sourceBranch: "<branchName>", state: "merged" }`.
     A non-null result → **drift A** (merged but still in_progress).
   - Scenario B: `baron_scm_pr_for_branch { sourceBranch: "<branchName>", state: "all" }`.
     A null result → **drift B** (in_review with no PR at all).
3. **Report + confirm.** Show a compact table (key · title · current role · finding · suggested fix).
   If nothing drifted, say so and stop. For the drift-A set, batch-confirm with `AskUserQuestion`
   ("N items merged but still in progress — move them to in_review?"). Drift-B items are reported for
   manual attention only.
4. **Apply** the confirmed drift-A fixes: `baron_issue_transition { id, role: "in_review" }` for each,
   then re-report what moved.

## Rules

- **Read-only until the user confirms.** Detection never mutates; only step 4 does, and only on an
  explicit batch-confirm.
- Never invent a branch — use the issue's `branchName` verbatim; skip items without one.
- A `dry-run` argument (or the user asking to "just show" / "sadece göster") means report and STOP —
  no transitions.
- Surface any `isError` code with its hint; a single item's failure must not abort the whole sweep —
  report it and continue with the rest.
