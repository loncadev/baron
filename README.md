# Baron

**Platform-agnostic work-orchestration layer for AI coding agents.**

Baron lets a coding agent (Claude Code, Cursor, Codex, any MCP client) or a CI pipeline drive
work tracking, source control, and notifications across many providers through one normalized
contract — instead of hardwiring a single vendor's API and one team's process template into
prompts.

- **Capability ports**, not "a tracker": `issues` / `scm` / `notify` / `docs`, each bound to a
  provider independently. Mix Linear issues with GitHub PRs and Slack notifications.
- **Semantic role layer**: providers model work too differently for a universal schema. Baron
  introspects each provider's real states and maps them to abstract roles
  (`backlog → ready → in_progress → in_review → done`). You confirm the mapping once.
- **Primitives in the core, workflows as portable recipes**: the deterministic provider
  abstraction is code (a TypeScript MCP server + CLI); the opinionated workflows
  (`task-start`, `task-finish`, ...) are declarative YAML recipes you can edit.
- **Cross-harness**: the core is an MCP server, so any MCP client can use it. Claude Code gets
  a richer plugin wrapper.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full decision record.

## Status

Pre-alpha. Building the first vertical slice: the `issues` port across Azure DevOps and GitHub.

## License

Open-core. The core, the P0 adapters (Azure DevOps, GitHub, Slack), the recipes, and the
CLI/MCP server are licensed under [Apache-2.0](./LICENSE). Enterprise features (SSO,
secret-manager integrations, multi-team governance, audit) will ship under a separate
commercial license.
