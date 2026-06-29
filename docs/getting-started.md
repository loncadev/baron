# Getting started

Baron configures itself against your real provider, then drives it through abstract primitives. This
guide takes you from a clone to a first recipe run.

## Prerequisites

- **Node.js ≥ 20** and **pnpm** (the repo pins a version via `packageManager`).
- A provider you can reach with a token:
  - **Azure DevOps** — an org + project (and a repo for the `scm` port) and a Personal Access Token.
  - **GitHub** — a repo and a fine-grained PAT / token.

## Install & build

```bash
pnpm install
pnpm build      # compiles every package to dist; required to run the CLI / MCP server
pnpm test       # optional: 170 tests, all network-free
```

### Running the CLI

Once Baron is published, `baron` (and `baron-mcp`) are on your PATH. To run from this monorepo
**before publishing**, use the wired-up workspace script (it runs the TypeScript source via `tsx`):

```bash
pnpm baron <command> [flags]        # e.g. pnpm baron init --provider azure-devops
pnpm baron:mcp                      # the MCP server over stdio
```

The examples below write `baron <command>`; from this repo, substitute `pnpm baron <command>`.

## 1. Configure — `baron init`

`init` introspects the provider (work-item types, states, board columns), **proposes** a role/type
mapping, asks you to confirm, and writes a committed `.baron/policy.json`. It also scaffolds
`.baron/credentials.example` and gitignores the real `.baron/credentials`.

```bash
baron init --provider azure-devops     # or: --provider github
```

You'll see the proposed mapping and any notes ("Matched board column 'Test' to role 'in_review' by
keyword; confirm it.") before anything is written. See [Configuration](./configuration.md) for the
file it produces.

## 2. Add credentials

Credentials never live in `policy.json`. Put them in the environment or in `.baron/credentials`
(gitignored). The keys per provider:

| Provider | Keys |
| --- | --- |
| Azure DevOps | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_REPO` (scm), `AZURE_DEVOPS_TOKEN` |
| GitHub | `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` |

## 3. Validate — `baron doctor`

```bash
baron doctor
```

`doctor` loads the policy, introspects the live provider, and reports drift — a mapped native state,
type, or board column that no longer exists. Exit code `0` means no drift.

## 4. Run a workflow — `baron run`

Recipes are declarative YAML workflows over the primitives. Two ship as examples:

```bash
baron run --recipe packages/recipes/recipes/task-start.yaml
```

`ask` steps prompt you for inputs; `do` steps create the issue, open the branch, transition it, etc.
See [Recipes](./recipes.md) to write your own.

## Or: drive it from an agent

Instead of the CLI, register Baron's MCP server with your agent and call the tools
(`baron_issue_create`, `baron_scm_pr_create`, `baron_learning_append`, …). The Claude Code plugin in
`plugins/claude-code` does this for you. See [MCP server & plugin](./mcp.md).

## Next

- [Concepts](./concepts.md) — the mental model (ports, roles, gaps).
- [Configuration](./configuration.md) — everything in `.baron/policy.json`.
