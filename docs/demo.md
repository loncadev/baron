# Demo script — the 60-second "single pane" moment

The one artifact that sells Baron fastest is a short recording of an agent driving a real workflow
through Baron's normalized tools. This is a ready-to-record script: run it top to bottom, keep it
under ~90 seconds. Two variants — pick the one that fits where you're recording.

> **The point the viewer must feel:** the agent speaks *roles and recipes*, never a vendor's column
> names, and the workflow runs as one deterministic call. On a different provider the *same* prompt
> would produce the *same* roles mapped to that provider's native states.

## Recording setup

- Terminal at ~100×30, large font, clean prompt. Close noisy panes.
- Record with [asciinema](https://asciinema.org): `asciinema rec baron-demo.cast` (then `exit` to stop;
  `asciinema upload baron-demo.cast`). For a GIF, convert with [agg](https://github.com/asciinema/agg):
  `agg baron-demo.cast baron-demo.gif`.
- Have `.baron/policy.json` + credentials already set up (do the boring setup off-camera).

## Variant A — Claude Code (the hero demo)

Show the agent using Baron's MCP tools / skills. Type these prompts; let the tool calls render.

1. **The hook — one prompt starts a whole task:**
   > Start a task: add rate limiting to the login endpoint.

   Baron runs the `task-start` recipe (`baron_recipe_run`) as one call: creates the issue (type role
   `task`), branches `feature/<id>` from the repo default, moves it to `in_progress`, comments the
   branch. Point out in voiceover/caption: *"`in_progress` is a role — on Azure DevOps that's the
   `Active` state; the agent never said `Active`."*

2. **Query it back in the abstract vocabulary:**
   > What's in progress right now?

   Baron calls `baron_issue_query` with `role: in_progress` — provider-scoped, normalized results (no
   294KB vendor dump; it's role-filtered).

3. **Ship it — cross-port in one call:**
   > Ship STORE-142 from feature/STORE-142, PR title "Rate limit login", pipeline ci-main.

   Baron runs the `ship` recipe: opens a draft PR (`scm`), moves the issue to `in_review` (`issues`),
   triggers the CI pipeline (`ci`), notifies the team (`notify`) — **four providers, one recipe.**

4. **Close on the tagline caption:** *"Same prompts, any stack. Roles, not vendor states."*

## Variant B — CLI only (no agent, fully deterministic)

For a provider-agnostic recording that needs no MCP client:

```bash
pnpm baron doctor                                                   # prove the live policy is healthy
pnpm baron run --recipe packages/recipes/recipes/task-start.yaml    # create + branch + in_progress
pnpm baron run --recipe packages/recipes/recipes/ship.yaml          # PR + in_review + CI + notify
```

Caption each step with the role it moved to, not the native state — that's the whole pitch.

## The killer beat (optional, if you have two providers configured)

Run the *same* `task-start` prompt/recipe against an Azure DevOps policy, then a GitHub policy,
side by side. Same abstract result; `in_progress` becomes `Active` on one and an `in-progress` label
on the other. This is the single most convincing 10 seconds you can show — it *is* the product.

## After recording

- Drop the GIF at the top of [README.md](../README.md) (above "The problem").
- Post it: "Show HN", the Claude Code plugin channels, relevant dev communities. Lead with the pain
  sentence from the README, not the feature list.
