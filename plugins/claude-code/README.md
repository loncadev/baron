# Baron — Claude Code plugin

The harness-specific wrapper around Baron: it registers the Baron **MCP server** (so the agent gets
the `baron_issue_*` / `baron_scm_*` / `baron_ci_*` / `baron_recipe_*` … tools) and ships **skills**
that teach the agent Baron's abstract vocabulary and wrap each packaged workflow. All workflow
opinion stays in the declarative recipes and `.baron/policy.json` — this plugin is the thin rendering
layer (decisions #2, #6, #7).

Workflows are surfaced the modern way — **skills, not slash commands** (custom commands have been
merged into skills). Each per-recipe skill is discoverable by description (natural language) and as a
`/baron:<name>` slash command, and runs the recipe as ONE deterministic `baron_recipe_run` call (the
engine enforces step order, not the agent).

## Layout

```
plugins/claude-code/
  .claude-plugin/plugin.json    # manifest + the `baron` stdio MCP server
  skills/baron/SKILL.md         # vocabulary + the MCP tool surface (abstract roles)
  skills/task-new/SKILL.md      # /baron:task-new    → CREATE a work item (type + parent)
  skills/task-start/SKILL.md    # /baron:task-start  → start an EXISTING item (canonical branch + in_progress)
  skills/task-finish/SKILL.md   # /baron:task-finish → push + draft PR (idempotent; role moves on merge)
  skills/task-move/SKILL.md     # /baron:task-move   → move to a role; backward/reopen needs a reason
  skills/task-list/SKILL.md     # /baron:task-list   → read-only listing over baron_issue_query
  skills/task-sync/SKILL.md     # /baron:task-sync   → sweep board↔PR drift (merged-but-stuck) + batch-fix
  skills/ship/SKILL.md          # /baron:ship        → runs the ship recipe
  skills/run-recipe/SKILL.md    # /baron:run-recipe  → runs any recipe by name (incl. project recipes)
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

The manifest launches the MCP server via `npx -y @lonca/baron-mcp-server@latest` (the explicit
`@latest` keeps `npx` from silently reusing a stale cached install). To run against a local build
instead, point the `mcpServers.baron` command at `node packages/mcp-server/dist/bin.js` after
`pnpm build`.

> Status: scaffold. The MCP server and recipes it fronts are covered by the workspace test suite;
> this plugin's wiring is validated by installing it into Claude Code (no automated test).
