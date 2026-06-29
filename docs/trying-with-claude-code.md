# Trying Baron with Claude Code (hands-on)

This is a practical walkthrough for driving Baron from Claude Code against a real project (the
examples use **BeeMaster** on Azure DevOps), plus a **verification checklist** you can run before,
during, and after.

The shape of "using" Baron is: **register its MCP server with your agent**, then ask the agent to do
work-orchestration in plain language — it calls the `baron_*` tools. The CLI (`baron init/doctor/run`)
is for configuring and for recipe runs; the MCP server is for letting Claude drive it live.

---

## A. Wire the MCP server into Claude Code

Claude Code reads a project's `.mcp.json`. Create **`BeeMaster/.mcp.json`**:

```jsonc
{
  "mcpServers": {
    "baron": {
      // Pre-publish: run the dev server from the baron repo via tsx.
      "command": "pnpm",
      "args": ["--dir", "C:/Users/empad/Desktop/Development/baron", "baron:mcp"],
      // Point the server at THIS project; it reads <root>/.baron/policy.json + credentials.
      "env": { "BARON_ROOT": "C:/Users/empad/Desktop/Development/BeeMaster" }
    }
  }
}
```

- The server reads `BeeMaster/.baron/policy.json` and overlays `BeeMaster/.baron/credentials` (your
  PAT) onto the environment — so credentials stay in the gitignored file, not in `.mcp.json`.
- Windows note: if Claude Code can't find `pnpm`, use `"command": "pnpm.cmd"`. Once `@baron/mcp-server`
  is published, this becomes `"command": "npx", "args": ["-y", "@baron/mcp-server"]` with the same
  `BARON_ROOT`.
- Restart Claude Code (or reload MCP servers) so it picks up the new server.

With BeeMaster's policy (issues bound, knowledge loop always on), Claude will see:
`baron_issue_create/get/transition/comment/link/query` and `baron_learning_*` / `baron_followup_*`.
(`baron_scm_*` appears only after you also bind `providers.scm`.)

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
- [ ] "List BeeMaster's backlog" returns the real New PBIs (e.g. *Master UI*, *API*, *Deployment*) — proves the live WIQL query path.
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
- The dev MCP launch via `pnpm`/`tsx` is a pre-publish convenience; publishing will make it `npx @baron/mcp-server`.
