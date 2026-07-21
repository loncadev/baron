# Getting started

Baron configures itself against your real provider, then drives it through abstract primitives. This
guide takes you from nothing to a working setup in one command, then either drives it from an agent
(the plugin) or from the CLI.

## Prerequisites

- **Node.js ≥ 20**.
- A cloned repo you want to track work for, and a provider token:
  - **GitHub** — a fine-grained PAT with **Contents**, **Issues**, and **Pull requests** = Read and
    write (Metadata read is automatic; add **Checks: Read** for PR-status/ship flows).
  - **Azure DevOps** — an org + project + repo and a Personal Access Token.

You do **not** clone Baron or run a build — everything is published to npm and runs via `npx`.

## 1. Configure — one command

From inside your project (so Baron can read your git remote), run:

```bash
npx -y @lonca/baron-cli@latest init --provider github     # or: --provider azure-devops
```

`init` does the whole setup:

- **Gathers credentials.** GitHub owner/repo are auto-detected from your `origin` remote; the token
  is prompted (entered hidden). It writes `.baron/credentials` and **gitignores it** — secrets never
  land in a commit. Keys already set in your environment are kept (CI wins), and a key left blank
  fails loudly instead of continuing with an empty token.
- **Introspects the provider** (work-item types, states, board columns), **proposes** a role/type
  mapping, and asks you to confirm before writing anything.
- **Writes `.baron/policy.json`** (committed — it holds no secrets), binding the provider to both the
  `issues` and `scm` ports, so branches and PRs work out of the box.

You'll see the proposed mapping and any notes ("Matched board column 'Test' to role 'in_review' by
keyword; confirm it.") before it writes. See [Configuration](./configuration.md) for the file it
produces, and [CLI](./cli.md) for every flag.

> Re-running is safe: existing credentials are preserved, and `--force` overwrites an existing
> `policy.json` without prompting.

## 2a. Drive it from Claude Code (the plugin)

Install the plugin once — it registers Baron's MCP server **and** the workflow skills together, so
they can't drift apart:

```
/plugin marketplace add loncadev/baron
/plugin install baron@baron
```

Then, in your project, just ask in plain language — the agent calls the `baron_*` tools and the
`task-*` skills:

- "List the GitHub issues assigned to me with Baron."
- "/baron:task-new — open a bug for the empty search results."
- "/baron:task-start 42" — cut the canonical branch, move it to in-progress, assign it to you, and
  read the whole item (description, comments, attachments) before starting.
- "/baron:task-finish" — push and open a draft PR.

Pick up new releases with `/plugin marketplace update baron` && `/plugin update baron@baron`. See
[MCP server & plugin](./mcp.md).

## 2b. Or drive it from the CLI

```bash
npx -y @lonca/baron-cli@latest doctor      # validate the policy against the live provider (drift → exit 1)
npx -y @lonca/baron-cli@latest run --recipe <path-to>/task-start.yaml
```

`doctor` reports a mapped native state/type/column that no longer exists (exit `0` = no drift).
`run` executes a declarative YAML recipe: `ask` steps prompt you, `do` steps create the issue, open
the branch, transition it, etc. See [Recipes](./recipes.md) to write your own.

## The `ci`, `deploy`, and `notify` ports

Beyond `issues` and `scm`, Baron exposes `ci` / pipelines, `deploy` / environments, and `notify`.

- **`ci` and `deploy`** reuse the *same* provider credentials and coordinates as `issues`/`scm` — no
  extra env keys and **no `init` step**, since their status maps are vendor-fixed adapter knowledge,
  not a human-confirmed mapping. Bind the provider once and they work.
- **`notify`** (Slack) needs its own credentials: `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`.

`recipes/ship.yaml` shows them together: open a draft PR → move to `in_review` → trigger CI → notify.

## Developing Baron itself

Contributing to Baron (not just using it)? Clone the repo and run from source — packages resolve to
TypeScript source, no build needed:

```bash
pnpm install
pnpm baron <command>        # e.g. pnpm baron init --provider github
pnpm baron:mcp              # the MCP server over stdio
pnpm test                  # the full suite is network-free
```

See [CONTRIBUTING](../CONTRIBUTING.md).

## Next

- [Concepts](./concepts.md) — the mental model (ports, roles, gaps).
- [Configuration](./configuration.md) — everything in `.baron/policy.json`.
- [Providers](./providers.md) — what each provider maps onto (and where GitHub is "correct but different").
