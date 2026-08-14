# MCP server & plugin

Baron's core is exposed as a stdio **MCP server** (`@lonca/baron-mcp-server`, bin `baron-mcp`), so any MCP
client — Claude Code, Cursor, Codex, … — can drive work tracking and source control by calling
tools. The Claude Code plugin is a thin wrapper that registers it.

## What the server does at startup

1. Loads `.baron/policy.json` from the working directory — or from `BARON_ROOT` when set, which lets
   a client (e.g. Claude Code) point the server at a project that isn't the server's own cwd (missing
   ⇒ `POLICY_NOT_FOUND`; run `baron init` first).
2. Builds the live ports the policy binds (any of `issues`, `scm`, `ci`, `deploy`, `notify`) plus the
   always-available local **knowledge loop** (markdown store under `.baron/knowledge`) and a
   **recipe runner** over those bound ports (built-ins by name + project recipes under
   `.baron/recipes`).
3. Advertises only the tools for the bound ports, and routes each call to the right port.

Credentials come from the environment (see [Configuration](./configuration.md)), never from the
policy.

## Tools

| Tool | Port | Purpose |
| --- | --- | --- |
| `baron_issue_create` | issues | Create an issue from abstract terms (`typeRole`, optional `initialRole`). |
| `baron_issue_get` | issues | Fetch a normalized issue by id. |
| `baron_issue_transition` | issues | Move an issue to a workflow `role`. |
| `baron_issue_reconcile` | issues | Clear a role label the provider's own state contradicts. Commands no role. |
| `baron_issue_block` | issues | Set the orthogonal blocked flag with a required `reason`. Does **not** change the role — the item keeps the role it is blocked in. |
| `baron_issue_unblock` | issues | Clear the blocked flag, optionally recording why. The role is untouched. |
| `baron_issue_update` | issues | Patch an issue's `title` and/or `body`. |
| `baron_issue_comment` | issues | Comment on an issue. |
| `baron_issue_link` | issues | Link two issues (`relates` / `blocks` / `blocked_by` / `duplicates`). |
| `baron_issue_assign` | issues | Assign an issue to a provider-native user handle (Azure: email; GitHub: login). |
| `baron_issue_iterations` | issues | List the provider's iterations/sprints (each with a `current` flag); empty when the provider has none. |
| `baron_issue_set_iteration` | issues | Move an item to an iteration by path, or `@current` for the active sprint. |
| `baron_issue_query` | issues | List issues filtered by `role` / `typeRole` / `assignee` (handle or `@me`) / `iteration` (path or `@current`) / `limit`. |
| `baron_scm_branch_create` | scm | Create a branch from a base branch. |
| `baron_scm_pr_create` | scm | Open a pull request (optional `draft`). |
| `baron_scm_pr_thread` | scm | Add a discussion thread/comment to a PR. |
| `baron_scm_pr_status` | scm | Normalized PR status: `state` (open/merged/closed/unknown), `reviewDecision`, `mergeable`, and a `checks` rollup. |
| `baron_scm_pr_for_branch` | scm | The most recent PR for a branch matching `state` (`open` default / `merged` / `closed` / `all`) with its `state`, or `null`. `open` = idempotency probe (check before `pr_create`); `merged` = drift probe. |
| `baron_ci_pipelines` | ci | List the pipelines/workflows defined for the repo. |
| `baron_ci_runs` | ci | List runs (defaults `limit` 50) with a normalized `RunStatus`. |
| `baron_ci_run_get` | ci | Fetch one run's detail, including per-stage status. |
| `baron_ci_run_logs` | ci | Fetch a run's logs (size-aware tail). |
| `baron_ci_run_trigger` | ci | Trigger a pipeline/workflow run. |
| `baron_ci_run_cancel` | ci | Cancel an in-flight run. |
| `baron_deploy_environments` | deploy | List deployment environments. |
| `baron_deploy_deployments` | deploy | List deployments with a normalized `DeployStatus`. |
| `baron_notify_send` | notify | Send a message (`text`, optional `channel`, optional `threadKey` for threaded replies). |
| `baron_recipe_list` | recipes | List the runnable recipes (built-ins + project recipes) and the `inputs` each declares. |
| `baron_recipe_run` | recipes | Run a named recipe end-to-end as ONE deterministic, rule-enforced call (`name`, `inputs`). The engine enforces step order; required inputs are validated up front (`RECIPE_INPUT_MISSING`) — it never prompts. Prefer this over hand-composing the primitives for a packaged workflow. Returns the run context as JSON plus, when the recipe said anything, a second text block carrying its messages — read it, that is where a recipe reports what it could not verify. |
| `baron_native_request` | — | **Escape hatch (last resort).** A non-portable raw authenticated provider REST call; only reaches providers the policy binds. Prefer the normalized tools above. |
| `baron_learning_append` | loop | Record a durable learning. |
| `baron_learning_query` | loop | Query learnings by tag / text. |
| `baron_followup_append` | loop | Record an open follow-up. |
| `baron_followup_list` | loop | List follow-ups by status / tag. |

Tool inputs are plain JSON Schema; the `role` / `typeRole` / link-type / status fields are enums
sourced from the core's abstract vocabulary, so they never expose provider-native states.

## Enforcing the recipe channel

Decision #19 says a recipe runs as one deterministic call and the **engine** enforces the step order.
That was true of the engine and false of this server: every mutating primitive sat in the same tool
list as `baron_recipe_run`, so the guarantee was a sentence in a skill prompt that anyone reading the
tool list could disprove.

Set it in `.baron/policy.json`:

```json
{ "mutations": { "channel": "recipe-only" } }
```

- `open` (the default, and what every install did before this existed) — any primitive may be called
  directly.
- `recipe-only` — a tool that changes a provider is **refused** with `MUTATION_OUTSIDE_RECIPE`, naming
  `baron_recipe_run` and pointing at `baron_recipe_list` to find the recipe that covers it.

The refused tools stay **listed**. Hiding them would trade an enforceable rule for an obscured one,
and an agent that cannot see a tool cannot be told why it may not use it. Reads are unaffected, and so
are the knowledge loop's own writes — refusing those would cost the record of a decision without
preventing a single provider write.

## Update notice

At startup the server checks the npm registry (once, in the background, 4s timeout) for a newer
`@lonca/baron-mcp-server`. When one exists, every successful tool result carries an extra content
block: `⚠️ @lonca/baron-mcp-server v0.3.0 outdated → v0.4.0 available. Restart the baron MCP
server…` — the first block stays untouched parseable JSON, and error results are never decorated.
An `@latest` npx launcher picks the new version up on the next restart. Offline/air-gapped
installs stay silent (a failed check is never an error); set `BARON_NO_UPDATE_CHECK=1` to disable
the check entirely.

## Errors: `isError`, not a thrown protocol error

A primitive that hits a capability gap or bad input returns an **`isError` tool result** whose text
begins with a stable code (`CAPABILITY_GAP`, `ROLE_MAPPING`, `INVALID_ARGS`, …) and which also rides
in `structuredContent.code`. This is deliberate: an `isError` result re-enters the model's context,
so an agent can read the gap and self-correct (retry with a different role, drop a parent), instead
of the failure being swallowed by the protocol channel. Calling a tool for an unconfigured port
returns `PORT_UNBOUND`.

## Claude Code plugin

`plugins/claude-code` registers the `baron` MCP server and ships **skills** — a `baron` skill that
teaches the agent the abstract vocabulary, plus a skill per packaged workflow (`/baron:task-start`,
`/baron:task-finish`, `/baron:ship`, and `/baron:run-recipe` for any other recipe). Each is
discoverable by description (natural language) and as a slash command, and runs the recipe as one
`baron_recipe_run` call. (Workflows are surfaced as skills, not slash commands — custom commands have
been merged into skills.) Install it for local development with:

```bash
claude --plugin-dir ./plugins/claude-code
```

Its `.claude-plugin/plugin.json` launches the server via `npx -y @lonca/baron-mcp-server@latest`
(the explicit `@latest` keeps `npx` from reusing a stale cached install); to run a local build
instead, point the `mcpServers.baron` command at it. See
[plugins/claude-code/README.md](../plugins/claude-code/README.md).
