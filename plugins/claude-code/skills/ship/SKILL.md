---
name: ship
description: >-
  Ship a change with Baron — open a draft PR, move the issue to in_review, trigger its CI pipeline,
  and notify the team, as ONE deterministic single-pane workflow across scm + issues + ci + notify.
  Use when the user says "ship it", "ship this change", or asks to PR + run CI + notify together.
---

# Ship a change

Run the **ship** recipe as a single deterministic call. This is a single-pane workflow spanning four
ports (scm → issues → ci → notify); do **not** perform the steps yourself — the Baron engine enforces
their order. Your job is only to gather the inputs and make one call.

## Inputs

- `issueId` — the issue being shipped (required).
- `branch` — the source branch the PR opens from and CI runs against (required).
- `title` — the pull request title (required).
- `pipelineId` — the CI pipeline to trigger (required).

If you are unsure, call `baron_recipe_list` and read `ship`'s `inputs`. The PR targets the repo's
default branch automatically.

## Run it

Call `baron_recipe_run` exactly once:

```json
{ "name": "ship", "inputs": { "issueId": "<id>", "branch": "<branch>", "title": "<PR title>", "pipelineId": "<pipeline id>" } }
```

## Rules

- Gather the inputs from context. Confirm the `pipelineId` if it is not obvious — triggering CI is a
  real side effect.
- Call `baron_recipe_run` **once**. Do NOT also call the scm/ci/notify tools yourself.
- If the result is an `isError` with a code (`RECIPE_INPUT_MISSING`, `CAPABILITY_GAP`,
  `PORT_UNBOUND`, …), surface the code and its hint and stop — do not retry blindly. `PORT_UNBOUND`
  means a port the recipe needs (e.g. ci or notify) is not bound in `.baron/policy.json`.
- On success, report the PR url, that CI was triggered, and that the team was notified.
