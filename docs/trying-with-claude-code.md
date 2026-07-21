# Trying Baron with Claude Code (hands-on)

This is a practical walkthrough for driving Baron from Claude Code against a real project (the
examples use **BeeMaster** on Azure DevOps), plus a **verification checklist** you can run before,
during, and after.

The shape of "using" Baron is: **register its MCP server with your agent**, then ask the agent to do
work-orchestration in plain language — it calls the `baron_*` tools. The CLI (`baron init/doctor/run`)
is for configuring and for recipe runs; the MCP server is for letting Claude drive it live.

---

## A. Wire Baron into Claude Code

**Recommended: install the plugin.** It registers the MCP server **and** the workflow skills
together (so they never drift), and updates in one step:

```
/plugin marketplace add loncadev/baron
/plugin install baron@baron
```

The plugin's server resolves the project root from the working directory, so no `.mcp.json` is
needed. Pick up releases with `/plugin marketplace update baron` && `/plugin update baron@baron`.
Do **not** also keep a `baron` server in the project's `.mcp.json` — two servers of the same name
collide.

<details>
<summary>Alternative: a manual <code>.mcp.json</code> (no plugin, MCP tools only — no skills)</summary>

Claude Code reads a project's `.mcp.json`. Create **`BeeMaster/.mcp.json`**:

```jsonc
{
  "mcpServers": {
    "baron": {
      "command": "npx",
      "args": ["-y", "@lonca/baron-mcp-server@latest"],
      // Point the server at THIS project; it reads <root>/.baron/policy.json + credentials.
      // Omit to use the working directory. The explicit @latest matters: a bare package name makes
      // npx reuse its cached install without re-checking the registry, pinning you to a stale version.
      "env": { "BARON_ROOT": "C:/Users/empad/Desktop/Development/BeeMaster" }
    }
  }
}
```

- The server reads `BeeMaster/.baron/policy.json` and overlays `BeeMaster/.baron/credentials` (your
  PAT) onto the environment — so credentials stay in the gitignored file, not in `.mcp.json`.
- Restart Claude Code (or reload MCP servers) so it picks up the new server.

</details>

With a policy that binds both ports (what `baron init` writes by default), Claude sees the issues
tools (`baron_issue_create/get/update/transition/comment/link/assign/query`), the scm tools
(`baron_scm_*`), and `baron_learning_*` / `baron_followup_*`.

### Example prompts to Claude

- "Using Baron, list BeeMaster's backlog items." → `baron_issue_query { role: backlog }`
- "Create a Baron task 'Try the issues port' and move it to in progress." → `baron_issue_create` + `baron_issue_transition`
- "Add a comment to issue 117 via Baron." → `baron_issue_comment`
- "Record a learning that the review state is 'Test'." → `baron_learning_append`

---

## B. Verification checklist

### Phase 0 — Before you start (setup is sound)

- [ ] `pnpm install && pnpm build` succeed in the baron repo.
- [ ] `pnpm test` is green (170+ passing).
- [ ] `BeeMaster/.baron/policy.json` exists and is the corrected map (states New/Active/Test/Closed; types Epic/PBI/Task).
- [ ] `BeeMaster/.baron/credentials` exists, is gitignored, and has a valid `AZURE_DEVOPS_TOKEN` (Work Items R/W; + Code R/W if you'll test scm).
- [ ] `pnpm baron doctor --root C:/Users/empad/Desktop/Development/BeeMaster` prints **"OK … no drift"** (exit 0). ✅ *(verified)*
- [ ] The MCP server starts: `pnpm baron:mcp` with `BARON_ROOT` set prints `baron mcp-server running on stdio (root: …BeeMaster)` to stderr, then waits. (Ctrl-C to stop.)

### Phase 1 — While running (read-only, safe)

- [ ] Claude Code lists the `baron_*` tools (issue + learning + followup).
- [ ] "List BeeMaster's backlog" returns the real New items (e.g. *Master UI*, *API*, *Deployment*) — proves the live WIQL query path. The query is scoped to the project and returns a lean projection (no body) capped at 50 by default; pass a higher `limit` for more.
- [ ] "Get issue 117" returns a normalized issue with `role: backlog`, `nativeType: Product Backlog Item`.
- [ ] `baron_learning_append` then `baron_learning_query` round-trips a note (writes a markdown file under `BeeMaster/.baron/knowledge/` — local, safe).

### Phase 2 — While running (writes to the real board — opt-in)

- [ ] `baron_issue_create { title: "Baron smoke", typeRole: task }` creates a work item; note its id.
- [ ] `baron_issue_transition { id, role: in_progress }` → the item's State becomes **Active** in Azure.
- [ ] `… role: in_review` → State becomes **Test**; `… role: done` → State becomes **Closed**.
- [ ] `baron_issue_comment { id, body: "via Baron" }` adds the comment.
- [ ] A capability gap is loud, not silent: e.g. `baron_issue_transition { role: blocked }` returns an `isError` result with code `ROLE_MAPPING` (blocked is unmapped in the policy).

### Phase 3 — After (confirm + clean up)

- [ ] Open the work item in the Azure DevOps web UI — its State + comment match what Baron did.
- [ ] Close or delete the throwaway item(s) you created.
- [ ] Review `BeeMaster/.baron/knowledge/` — the learning/followup markdown files are human-readable.
- [ ] Decide what to commit in BeeMaster: `.baron/policy.json` (yes, committed), `.baron/credentials` (never — gitignored).

### Phase 4 — CI / deploy / notify (optional)

`ci` and `deploy` reuse the **same** Azure DevOps credentials/coordinates as issues/scm — no extra env
keys and **no `baron init` step** (CI/deploy status maps are vendor-fixed adapter knowledge, not
user-confirmed). `notify` (Slack) is separate: set `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` and bind
`providers.notify` to use it.

- [ ] `baron_ci_pipelines` lists BeeMaster's pipelines; `baron_ci_runs { pipeline }` returns recent runs (defaults to the last 50) with a normalized `status` (`queued|running|succeeded|failed|canceled|skipped|waiting|unknown`).
- [ ] `baron_ci_run_get { id }` returns run detail incl. per-stage status; `baron_ci_run_logs { id }` returns a size-aware tail of the logs.
- [ ] `baron_deploy_environments` lists environments; `baron_deploy_deployments { environment }` returns deployments with a normalized `status` (`pending|running|succeeded|failed|canceled|skipped|unknown`).
- [ ] `baron_notify_send { text: "BeeMaster CI green" }` posts to the configured Slack channel (add `threadKey` to reply in a thread).
- [ ] **Opt-in (writes/triggers):** `baron_ci_run_trigger { pipeline }` queues a run; `baron_ci_run_cancel { id }` cancels one. Only run these if you mean to.

**Example prompts to Claude**

- "Using Baron, show me BeeMaster's pipelines and the status of the latest run." → `baron_ci_pipelines` + `baron_ci_runs`
- "Fetch the logs for run 4821 and tell me why it failed." → `baron_ci_run_logs`
- "List BeeMaster's environments and their latest deployments." → `baron_deploy_environments` + `baron_deploy_deployments`
- "Post 'CI is green on main' to Slack via Baron." → `baron_notify_send`
- "Trigger the CI pipeline for BeeMaster." → `baron_ci_run_trigger` *(opt-in write)*

---

## What works vs. what's known-limited (today)

**Validated live against BeeMaster:** `baron init` (introspect + propose), `baron doctor` (drift), the
credentials-file loading, and the CLI/MCP running from source. The issues transport's
create/get/transition/comment/query/link are covered by the network-free conformance suite; Phase 2
above is what confirms them against the live API for the first time.

**Known-limited / not yet done:**
- **scm port** isn't bound in BeeMaster's policy yet — add `"providers": { …, "scm": "azure-devops" }`
  and set `AZURE_DEVOPS_REPO` to test branches/PRs (writes to the repo).
- **Board columns** were intentionally left out of the policy — Baron sets `System.State` and lets
  Azure derive the board column. (Explicit board-column moves are provider-quirky; see the providers doc.)
- **`in_review` / `blocked`:** `in_review` → state `Test`; `blocked` is unmapped (transitioning to it
  errors loudly by design — map it if your process has a blocked state).
- **Reverse type-role** is best-effort when several roles map to one native type.
- Prefer the published plugin (`/plugin install baron@baron`) over a hand-written `.mcp.json`; the
  `pnpm`/`tsx` launch is only for developing Baron itself from a clone.
