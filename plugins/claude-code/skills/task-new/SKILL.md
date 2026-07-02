---
name: task-new
description: >-
  Create a NEW work item with Baron — infer the type role (task/bug/story), resolve the right
  parent, and create it as one deterministic call. Use when the user describes new work to record
  ("we need...", "bug:", "add a task for..."). Starting work on it afterwards is task-start.
argument-hint: "<short description>"
---

# Create a work item

Gather the inputs interactively, then run the **task-new** recipe as ONE deterministic call. This is
the creation flow only — it does not branch or change your checkout (that's `/task-start`).

## Steps

1. **Infer the type role** from the user's wording: defect/broken/error → `bug`; a user-facing
   capability → `story`; a concrete engineering step → `task`. If ambiguous, ask via
   `AskUserQuestion` (options: task / bug / story).
2. **Resolve the parent** (hierarchy is real in trackers — a dangling item gets lost):
   - `bug`/`task` belong under a **story**; a `story` belongs under an **epic**.
   - Find candidates with `baron_issue_query` (`typeRole: "story"` or `"epic"`) and offer the best
     2-3 via `AskUserQuestion`, plus "no parent". Never invent a parent id.
   - On providers without native hierarchy the parent is emulated/degraded per policy — that is
     Baron's job, not yours.
3. **For a bug, elicit repro steps** (one or two lines minimum) and put them in the title/body ask;
   a bug without repro is guesswork for whoever picks it up.
4. **Run the recipe** — call `baron_recipe_run` exactly once:

   ```json
   { "name": "task-new", "inputs": { "title": "<title>", "typeRole": "<task|bug|story>", "parentId": "<id or omit>" } }
   ```
5. **Report** the created key + title + url, and offer the natural next step: `/task-start <id>`.

## Rules

- Call `baron_recipe_run` **once**; do not also call `baron_issue_create` yourself.
- Take the title from the user's request — sharpen wording, don't change meaning.
- Surface any `isError` code (`TYPE_MAPPING`, `CAPABILITY_GAP`, ...) with its hint and stop.
