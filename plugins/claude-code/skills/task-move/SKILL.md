---
name: task-move
description: >-
  Move a work item to a workflow role with Baron — guarding backward/reopen moves behind a required
  one-line reason (posted on the item first). Use when the user asks to change a task's state/column,
  send it back, reopen it, block/unblock it, or advance it. Roles, not vendor columns — works on any
  provider Baron binds.
argument-hint: <id?> <role>
---

# Move a work item to a role

Baron's `baron_issue_transition` resolves an abstract **role** to the provider's native
state/column atomically (Azure: state + board column; GitHub: label + open/closed). This skill wraps
it with the reference's governance: **backward and reopen moves require a reason**, and the reason is
recorded on the item *before* the state changes.

## The role order (the guard rule)

```
backlog(0) → ready(1) → in_progress(2) → in_review(3) → done(4)      blocked = orthogonal
```

Classify the move from the item's current role to the target:

- **advance** — to a higher index → just move.
- **regress** — to a lower index (not from `done`) → **reason required**.
- **reopen** — from `done` to any active role → **reason required**.
- **block** — to `blocked` → **reason required** (why is it blocked?).
- **unblock** — from `blocked` to an active role → just move.
- **noop** — same role → report and stop (idempotent, nothing to do).

## Steps

1. **Resolve inputs.** Target `role` from the argument (must be one of the six workflow roles — reject
   anything else, listing the valid ones). The `id`: from the argument, else derive it from the
   current branch (`<prefix>/<id>-<slug>`); if neither, ask.
2. **Load** the item: `baron_issue_get { id }` → its current `role`.
3. **Classify** the move (table above). If **noop**, report "already <role>" and stop.
4. **Reason gate.** For **regress / reopen / block**, ask the user for a one-line reason (plain text —
   this is open-ended, so ask directly, don't use a menu). Do not proceed without it. Then post it:
   `baron_issue_comment { id, body: "<move>: <reason>" }` — *before* the transition, so the card's
   history explains the change.
5. **Move:** `baron_issue_transition { id, role }`.
6. **Report:** `<key>  <oldRole> → <newRole>` (+ the reason when one was given).

## Rules

- Never skip the reason gate for a backward/reopen/block move — that governance is the whole point.
- Post the reason as a **comment** (`baron_issue_comment`), never bury it in an ad-hoc field.
- Surface any `isError` code (`ROLE_MAPPING` when the target role isn't mapped for this provider,
  `CAPABILITY_GAP`, …) with its hint and stop; don't retry blindly.
- This pairs with `/baron:task-sync`, which *detects* drift and proposes moves — task-move is how you
  apply one deliberately.
