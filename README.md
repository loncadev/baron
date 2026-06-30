# Baron

**Platform-agnostic work-orchestration layer for AI coding agents.**

Baron lets a coding agent (Claude Code, Cursor, Codex, any MCP client) or a CI pipeline drive
work tracking, source control, CI/pipelines, deployments, and notifications across many providers
through one normalized contract — instead of hardwiring a single vendor's API and one team's
process template into prompts. One pane of glass from backlog to deploy.

- **Capability ports**, not "a tracker": `issues` / `scm` / `ci` / `deploy` / `notify`, each bound
  to a provider independently. Mix Linear issues with GitHub PRs and Slack notifications.
- **Semantic role layer**: providers model work too differently for a universal schema. Baron
  introspects each provider's real states and maps them to abstract roles
  (`backlog → ready → in_progress → in_review → done`). You confirm the mapping once.
- **Primitives in the core, workflows as portable recipes**: the deterministic provider
  abstraction is code (a TypeScript MCP server + CLI); the opinionated workflows
  (`task-start`, `task-finish`, ...) are declarative YAML recipes you can edit.
- **Cross-harness**: the core is an MCP server, so any MCP client can use it. Claude Code gets
  a richer plugin wrapper.

## Quick start

```bash
pnpm install
pnpm build            # compile every package to dist (needed to run the CLI / MCP server)

# 1. Configure: introspect a provider and write .baron/policy.json (you confirm the mapping)
baron init --provider azure-devops      # or: --provider github

# 2. Add credentials (env or .baron/credentials — never committed). For Azure DevOps:
#    AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_REPO, AZURE_DEVOPS_TOKEN

# 3. Check the policy against the live provider
baron doctor

# 4. Run a workflow recipe
baron run --recipe packages/recipes/recipes/task-start.yaml
```

Or wire the MCP server into your agent and call the tools directly across every port —
`baron_issue_create`, `baron_scm_pr_create`, `baron_ci_runs`, `baron_deploy_deployments`,
`baron_notify_send`, … See [docs/mcp.md](./docs/mcp.md).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Install, prerequisites, first `init` → `doctor` → `run`. |
| [Setup walkthrough — Azure DevOps](./docs/setup-azure-devops.md) | From-scratch, copy-paste setup on Azure DevOps + Claude Code (PAT scopes, init→doctor→MCP, troubleshooting). |
| [Concepts](./docs/concepts.md) | Ports, roles, capability gaps, the knowledge loop — the mental model. |
| [Configuration](./docs/configuration.md) | `.baron/policy.json`, role/type/gap maps, credentials. |
| [CLI](./docs/cli.md) | `baron init` / `doctor` / `run` reference. |
| [Recipes](./docs/recipes.md) | Writing YAML recipes: `ask` / `do` / `message`, interpolation, the op table. |
| [MCP server & plugin](./docs/mcp.md) | The MCP tools and the Claude Code plugin. |
| [Trying it with Claude Code](./docs/trying-with-claude-code.md) | Hands-on: wire the MCP server to a real project + a verification checklist. |
| [Providers](./docs/providers.md) | Which provider supports which port and capability. |

The full design decision record is in [ARCHITECTURE.md](./ARCHITECTURE.md); the working contract
for contributors is [CLAUDE.md](./CLAUDE.md).

## Status

The planned v1 is built end-to-end: the `issues`, `scm`, `ci`, and `deploy` ports across
**Azure DevOps** and **GitHub** plus `notify` via **Slack**, the config engine
(`baron init` / `doctor`), a multi-port MCP server, the YAML recipe engine + `baron run`, the
knowledge loop, and a Claude Code plugin. The provider transports are
validated by a conformance suite and adversarial review but are exercised against live APIs only by
credential-gated smoke tests — running those against a real project is the next step.

## License

Open-core. The core, the P0 adapters (Azure DevOps, GitHub, Slack), the recipes, and the
CLI/MCP server are licensed under [Apache-2.0](./LICENSE). Enterprise features (SSO,
secret-manager integrations, multi-team governance, audit) will ship under a separate
commercial license.
