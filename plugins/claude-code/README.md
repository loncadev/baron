# Baron — Claude Code plugin

The harness-specific wrapper around Baron: it registers the Baron **MCP server** (so the agent gets
the `baron_issue_*` / `baron_scm_*` tools), ships a **skill** that teaches the agent Baron's abstract
vocabulary, and a **`/baron-run`** command for executing recipes. All workflow opinion stays in the
declarative recipes and `.baron/policy.json` — this plugin is the thin rendering layer (decisions
#2, #6, #7).

## Layout

```
plugins/claude-code/
  .claude-plugin/plugin.json   # manifest + the `baron` stdio MCP server
  skills/baron/SKILL.md        # how to drive the issues/scm ports by abstract role
  commands/baron-run.md        # /baron-run <recipe-path>
```

## Prerequisites

1. A committed `.baron/policy.json` — create it with `baron init` (binds each port to a provider and
   maps roles ↔ native states).
2. Credentials in the environment or `.baron/credentials` (gitignored, never committed), e.g.
   `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_TOKEN` or
   `AZURE_DEVOPS_ORG` / `AZURE_DEVOPS_PROJECT` / `AZURE_DEVOPS_REPO` / `AZURE_DEVOPS_TOKEN`.

## Install (local, for development)

```
claude --plugin-dir ./plugins/claude-code
```

The manifest launches the MCP server via `npx -y @baron/mcp-server`. Before that package is
published, point the `mcpServers.baron` command at your local build (`pnpm build`, then
`node packages/mcp-server/dist/bin.js`) instead.

> Status: scaffold. The MCP server and recipes it fronts are covered by the workspace test suite;
> this plugin's wiring is validated by installing it into Claude Code (no automated test).
