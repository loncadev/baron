---
name: task-new
description: >-
  Create a NEW work item with Baron — reach a well-specified item first (grill for the missing
  detail when the input is thin), infer the type role (task/bug/story), resolve the right parent,
  then create it. Use when the user describes new work to record ("we need...", "bug:", "add a task
  for..."). Starting work on it afterwards is task-start.
argument-hint: "<short description>"
---

# Create a work item

Turn the user's request into a work item that is **actually actionable by whoever picks it up** — not
a bare title — then run the **task-new** recipe as ONE deterministic call. Creation only; it does not
branch or change your checkout (that's `/task-start`).

## Steps

1. **Infer the type role** from the wording: defect/broken/error → `bug`; a user-facing capability →
   `story`; a concrete engineering step → `task`. If ambiguous, ask via `AskUserQuestion` (task / bug
   / story).

2. **Reach a well-specified item BEFORE creating — don't open a hollow title.** A title-only issue is
   guesswork for the next person. Decide how much you already have:
   - **The context already settles it** — the conversation made the decisions and now says "make a
     task for it", or the user's message already carries the what + why (+ repro for a bug). Then
     **synthesize the body from that context**; don't re-ask what you already know.
   - **The input is thin** — just a short title, no substance. Then **grill to decision-saturation**
     with `AskUserQuestion` before creating: ask only the few questions that actually change the body —
     typically *what problem / goal*, *why now / value*, *what "done" means (acceptance)*, and for a
     **bug** the *repro → expected → observed*. Stop as soon as you could write a body someone else
     could act on; don't interrogate past that.
   - **Respect a deliberate quick capture.** If the user says "just create it" / "only the title for
     now", create with what you have — a note in the body that detail is TBD, not a wall of questions.

   Compose the gathered detail into a clear **body** (markdown). This is what makes the item useful;
   the title alone never is.

3. **Resolve the parent** (a dangling item gets lost):
   - `bug`/`task` belong under a **story**; a `story` belongs under an **epic**.
   - Find candidates with `baron_issue_query` (`typeRole: "story"` or `"epic"`) and offer the best
     2-3 via `AskUserQuestion`, plus "no parent". Never invent a parent id.
   - On providers without native hierarchy the parent is emulated/degraded per policy — Baron's job.

4. **Run the recipe** — call `baron_recipe_run` exactly once, passing the **body** you composed:

   ```json
   { "name": "task-new", "inputs": { "title": "<title>", "typeRole": "<task|bug|story>", "body": "<the composed description>", "parentId": "<id or omit>" } }
   ```

   The adapter routes the body to the type's native field (a bug's body → Azure ReproSteps; GitHub has
   one body field for every type).

5. **Report** the created key + title + url, and offer the natural next step: `/task-start <id>`.

## Rules

- Call `baron_recipe_run` **once**; do not also call `baron_issue_create` yourself.
- **Never create a title-only item from a thin request without either grilling or an explicit
  "just the title".** The whole point is an actionable item.
- Take the title from the user's request — sharpen wording, don't change meaning.
- Surface any `isError` code (`TYPE_MAPPING`, `CAPABILITY_GAP`, ...) with its hint and stop.
