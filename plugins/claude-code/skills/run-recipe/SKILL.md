---
name: run-recipe
description: >-
  Run any Baron recipe by name as ONE deterministic, rule-enforced workflow. Use when the user names
  a recipe to run (including a project recipe under .baron/recipes) and no dedicated skill covers it.
argument-hint: <recipe-name>
---

# Run a recipe

Run a named Baron recipe end-to-end via `baron_recipe_run` — the engine enforces the step order, not
you. For the built-in workflows prefer the dedicated skills (`/baron:task-start`,
`/baron:task-finish`, `/baron:ship`); use this skill for any other recipe, including project recipes
in `.baron/recipes/*.yaml`.

## Steps

1. Call `baron_recipe_list` to find the recipe and read the `inputs` it declares.
2. Gather every required input from the user's request and context. Ask only for what is genuinely
   missing — never invent a value.
3. Call `baron_recipe_run` **once**:

   ```json
   { "name": "<recipe name>", "inputs": { "<input>": "<value>" } }
   ```

## Rules

- Do NOT compose the individual `baron_issue_*` / `baron_scm_*` / `baron_ci_*` tools yourself to
  emulate the recipe — call `baron_recipe_run` so the workflow runs atomically and in order.
- If the result is an `isError` with a code (`RECIPE_NOT_FOUND`, `RECIPE_INPUT_MISSING`,
  `CAPABILITY_GAP`, `PORT_UNBOUND`, …), surface the code and its actionable hint and stop — do not
  retry blindly.
- On success, report the workflow's outcome from the returned context (ids, urls, new roles).
