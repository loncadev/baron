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

| Tool | Port | Ops |
| --- | --- | --- |
| `baron_issue_read` | issues | `get` · `query` · `iterations` |
| `baron_issue_write` | issues | `create` · `update` · `comment` · `assign` · `link` · `set_iteration` |
| `baron_issue_move` | issues | `transition` · `reconcile` · `block` · `unblock` — the semantic role layer, plus the orthogonal blocked flag |
| `baron_scm_read` | scm | `pr_status` · `pr_for_branch` |
| `baron_scm_write` | scm | `branch_create` · `pr_create` · `pr_thread` · `pr_ready` · `pr_merge` |
| `baron_ci_read` | ci | `pipelines` · `runs` · `run_get` · `run_logs` |
| `baron_ci_run` | ci | `trigger` · `cancel` |
| `baron_deploy_read` | deploy | `environments` · `deployments` |
| `baron_notify_send` | notify | Send a message (`text`, optional `channel`, `threadKey`). |
| `baron_recipe_list` | recipes | The runnable recipes and the `inputs` each declares. |
| `baron_recipe_run` | recipes | Run a named recipe end-to-end as ONE deterministic, rule-enforced call. Returns the run context as JSON plus, when the recipe said anything, a second text block carrying its messages — read it, that is where a recipe reports what it could not verify. |
| `baron_memory_append` | loop | `learning` · `followup` — Baron's own store, not a provider's. |
| `baron_memory_query` | loop | `learning` · `followup` |
| `baron_native_request` | — | **Escape hatch (last resort).** A non-portable raw authenticated provider REST call; only reaches providers the policy binds. Prefer the normalized tools above. |

One tool per **verb**, not per endpoint: fourteen published tools in front of thirty-six primitives.
Cursor caps a session at 40 tools in total, and publishing one per primitive spent 27 of that on an
issues+scm install — so Baron alone consumed most of a user's budget and could not be installed next
to the provider MCP servers it exists to sit above.

Every op is named, enumerated and typed; the primitive behind it is unchanged, and so is its
validation. This is deliberately **not** a generic passthrough — there is no way to reach a provider
through these that Baron did not already model.

Tool inputs are plain JSON Schema; the `role` / `typeRole` / link-type / status fields are enums
sourced from the core's abstract vocabulary, so they never expose provider-native states.

## Toolsets: what an install publishes

Cursor caps a session at **40 tools in total**. Publishing everything a policy binds spends 27 of
that on an issues+scm install, so Baron cannot sit next to the provider MCP servers it is meant to
sit above — the opposite of the point.

`minimal` publishes the **recipe channel plus every tool that changes no provider**: 11 on an
issues+scm install instead of 27. That follows the product's own argument — work goes through
recipes, so the mutating primitives are the ones you opt into, and they are exactly the ones
`recipe-only` would refuse anyway.

```json
{ "tools": { "publish": "minimal" } }
```

- `all` (absent) — everything the bound ports offer. Still the default, because the shipped Claude
  Code skills call mutating primitives **by name**: `minimal` hides the tools they call and breaks
  them out of the box. Flipping the default waits on those skills going through recipes.
- `minimal` — the recipe channel whole, plus every tool that does not change a provider.
- a list of toolsets — `issues`, `scm`, `ci`, `deploy`, `notify`, `recipes`, `knowledge`, `native`.
  Explicit means explicit: asking for `["issues"]` does not quietly add the recipe channel back.

A toolset whose port is unbound is never published, whatever the rule says.

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
