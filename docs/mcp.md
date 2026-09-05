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

**You probably do not need this.** Cursor caps a session at 40 tools, and consolidating by verb
brought a typical issues+scm install to **10** — Baron already sits comfortably next to the provider
MCP servers it exists to sit above. Toolsets predate that fix; they now serve taste and policy rather
than budget.

`minimal` publishes the **recipe channel plus every tool that changes no provider**. That follows the
product's own argument — work goes through recipes, so the mutating primitives are the ones you opt
into, and they are exactly the ones `recipe-only` would refuse anyway.

```json
{ "tools": { "publish": "minimal" } }
```

- `all` (absent) — everything the bound ports offer. The default, and expected to stay one: the
  shipped Claude Code skills need provider writes, so `minimal` hides tools they call. With the
  budget problem gone there is nothing to buy by flipping it.
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

A second, network-free check runs beside it and takes precedence when both fire. The Claude Code
plugin pins its **skills and steering** to a commit while launching the server with `@latest`, so the
two halves of one install move at different speeds — and a plugin frozen before a tool rename hands
an agent instructions naming tools the server no longer publishes. The plugin manifest therefore
declares the release its skills came from (`BARON_PLUGIN_VERSION` in its `env`), and a server newer
than that says so:

> ⚠️ The Baron plugin here is v0.31.1 but this server is v0.34.0. Its skills and steering are from
> the older release and may name tools this server no longer publishes…

A plugin AHEAD of its server gets the opposite notice, and the opposite remedy — restart the server,
or raise the version its launcher pins. That direction was silent at first, on the reasoning that a
newer client meant someone had pinned the server back on purpose; it does not, because the skills
ship through the marketplace and the recipes and tools they call ship through npm, so either half can
be the one in front between two updates.

Nothing is said when the two agree, or when no version is declared at all — a hand-wired `.mcp.json` has no companion
artifacts to be stale, and warning every install would make the notice one nobody believes on the day
it matters. Installs predating the check declare nothing, so it starts working from the first plugin
release that carries the field.

## Errors: `isError`, not a thrown protocol error

A primitive that hits a capability gap or bad input returns an **`isError` tool result** whose text
begins with a stable code (`CAPABILITY_GAP`, `ROLE_MAPPING`, `INVALID_ARGS`, …) and which also rides
in `structuredContent.code`. This is deliberate: an `isError` result re-enters the model's context,
so an agent can read the gap and self-correct (retry with a different role, drop a parent), instead
of the failure being swallowed by the protocol channel. Calling a tool for an unconfigured port
returns `PORT_UNBOUND`.

A refusal that names things also carries them as data, in `structuredContent.details`, so the agent
can act without parsing prose. `TRANSITION_NOT_PERMITTED` lists the targets the provider permits
from the item's current state. `TRANSITION_FIELDS_REQUIRED` — a provider whose transition carries a
screen, such as Jira's "Resolve" — lists every field the move wants, with `required` and any
`allowedValues`; the agent asks once and retries `baron_issue_move { op: "transition" }` with the
answers in `fields`, keyed by the names exactly as reported.

## Running it as a container

`npx` is the shortest path and the one the plugin manifest uses; a container is there for anyone who
would rather not have Node on the host, and for the indexers that build every open-source MCP server
in a sandbox before listing it.

```bash
docker build -t baron-mcp .
docker run -i --rm -v "$PWD:/project" -e BARON_ROOT=/project baron-mcp
```

`-i` is not optional: the client speaks JSON-RPC over stdin/stdout, so a container without an open
stdin has nothing to talk to. Logs go to stderr — anything on stdout corrupts the stream.

The image bakes in Baron's **own** committed `.baron/policy.json` as the default root, purely so a
bare `docker run` starts and can be introspected: the server refuses to start without a policy
(`POLICY_NOT_FOUND`), and a container that dies immediately is indistinguishable from a broken image.
It is policy only. No credentials are in the image — `.dockerignore` keeps `.baron/credentials` out
and CI asserts it, because a layer keeps a file even when a later step deletes it. Mount your own
project and every call runs against your policy and your credentials instead.

To check any launch path — image, local build, or a published tarball — speak the protocol to it:

```bash
node scripts/mcp-handshake.mjs docker run -i --rm baron-mcp
```

It performs the same `initialize` → `tools/list` exchange an indexer does, and fails loudly on the
two things that break stdio servers quietly: a process that exits before answering, and anything
non-JSON on stdout.

### Docker MCP Toolkit

The same image is listed in the [Docker MCP Catalog](https://hub.docker.com/mcp) as `mcp/baron`,
built and signed by Docker from the pinned commit in
[docker/mcp-registry](https://github.com/docker/mcp-registry/tree/main/servers/baron). Enabling it
from Docker Desktop's MCP Toolkit asks for one required value — the host path of the project that
holds your `.baron/policy.json` — and mounts it over `/project`. Run `npx @lonca/baron init` in that
project first; the container has no `baron` CLI and cannot create the policy for you.

Provider credentials are optional in the form. Whatever you enter arrives as environment variables
and wins over the mounted project's `.baron/credentials`; a field left blank is treated as absent, so
the file fills it. Only the providers your policy binds need values — `PORT_UNBOUND` is what you get
for the rest, exactly as with `npx`.

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
