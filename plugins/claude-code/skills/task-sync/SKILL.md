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
- **C — closed with a stale role label** (label-keyed providers): the item's role reads `done`
  (the provider closed it — a PR merging with `Closes #N`) but `labels` still carries another
  role's label, so boards and label filters keep showing it as in-flight. Auto-fixable: run the
  `task-reconcile` recipe. It commands no role — it clears the label the provider's own state
  contradicts. Prefer it over a transition here: transitioning would work on GitHub and be wrong on a
  provider where a close does not mean `done`. Since task-land reconciles after
  every merge, this class should now only appear for items landed before that, or where the
  provider had not closed the item yet when the run finished.

- **D — merged-but-still-in-review**: role is `in_review` AND its branch has a **merged** PR
  → should be `done`. Auto-fixable. This is the ordinary aftermath of `task-land` on a provider that
  does not close an item when its PR merges — Jira, and Azure Boards without a linked repository —
  so on those providers expect one of these per landed item.

- **B — in-review-without-a-PR** (rare): role is `in_review` AND its branch has **no** PR at all
  → flag for the human; do NOT auto-change (something is off — wrong branch, force-push, manual move).

## Steps

1. **Detect — one call, no correlating by hand.**
   `baron_recipe_run { name: "task-sync-report", inputs: { scope } }` — `scope: "all"` sweeps
   everyone, empty sweeps the caller's own items. The engine runs the sweep and its context comes
   back with three lists of item keys:
   - `mergedButOpen` — class A, auto-fixable
   - `mergedButInReview` — class D, auto-fixable
   - `reviewWithoutPr` — class B, report only
2. **Class C is yours to spot.** The report cannot express it: recipe conditions compare values, they
   do not search a list of labels. Read it off `baron_issue_read { op: "query", role: "done" }` and
   look for a stale role label. Reading is always allowed; fixing goes through a recipe like
   everything else.
3. **Report + confirm.** A compact table (key · current role · finding · fix). Nothing drifted → say
   so and stop. Batch-confirm the class-A and class-D sets with `AskUserQuestion`. Class B is never
   auto-fixed.
4. **Apply — one recipe call per item**, so one failure cannot abort the rest:
   - class A → `baron_recipe_run { name: "task-move", inputs: { issueId, role: "in_review" } }`
   - class D → `baron_recipe_run { name: "task-move", inputs: { issueId, role: "done" } }`
   - class C → `baron_recipe_run { name: "task-reconcile", inputs: { issueId } }`

## Rules

- **Every mutation goes through a recipe.** Not a style preference: an installation may set
  `policy.mutations.channel` to `recipe-only`, and a direct `baron_issue_move` is REFUSED there. This
  skill used to prescribe exactly that, so on those installs it could fix nothing at all — and the
  refusal told the caller to find the recipe that covers it, which did not exist.
- **Read-only until the user confirms.** Detection cannot mutate: `task-sync-report` has no mutating
  step in it.
- Never invent a branch. The report correlates on each item's own `branchName` and skips items
  without one — containers never have a PR, and their absence is not a finding.
- A `dry-run` argument, or the user asking to preview, means steps 1–3 and STOP.
- Surface any `isError` code with its hint. One item's failure must not abort the sweep, which is why
  the fixes are separate calls rather than one batch.
