# Setup walkthrough — Baron on Azure DevOps (from scratch)

A complete, copy-paste walkthrough to wire Baron to an **Azure DevOps** project and drive it from
**Claude Code**, as a first-time user. End state: you ask Claude things like *"list my backlog"* or
*"start a task and open a PR"* and it does them through Baron's normalized tools.

> Baron is pre-publish, so you run it from the cloned repo (via `pnpm`/`tsx`). Once `@lonca/baron-*` is on
> npm, the same steps use `npx @lonca/baron-mcp-server` instead — noted where it matters.

---

## 0. What you'll end up with

- `<your-project>/.baron/policy.json` — committed config mapping Baron's abstract roles/types onto
  your Azure DevOps process (you confirm the mapping once).
- `<your-project>/.baron/credentials` — gitignored secrets (your PAT). **Never committed.**
- `<your-project>/.mcp.json` — tells Claude Code to launch Baron's MCP server for this project.

---

## 1. Prerequisites

- **Node ≥ 20** and **pnpm** (`npm i -g pnpm`).
- An **Azure DevOps** project you can access (org / project, and a repo if you want branches/PRs).
- **Claude Code** (CLI, desktop, or IDE extension).
- The **Baron repo** cloned locally — referred to below as `<baron>` (e.g.
  `C:/Users/you/Development/baron`).

```bash
cd <baron>
pnpm install
pnpm build        # compiles every package; also confirms your toolchain is good
pnpm test         # optional sanity check — should be green
```

The repo exposes two convenience scripts you'll use: `pnpm baron <cmd>` (the CLI) and `pnpm baron:mcp`
(the MCP server).

---

## 2. Create an Azure DevOps Personal Access Token (PAT)

Azure DevOps → **User settings → Personal access tokens → New Token**. Pick the scopes for the ports
you'll use:

| You want to… | Port | PAT scope |
| --- | --- | --- |
| Read/create/transition work items | `issues` | **Work Items** → Read & Write |
| Branches + pull requests | `scm` | **Code** → Read & Write |
| List/trigger/cancel pipeline runs, read logs | `ci` | **Build** → Read & Execute |
| List environments + deployments | `deploy` | **Environment** → Read (or Build → Read) |

For a quick first test, a token with **Work Items (R&W)** is enough; add the others as you go. (A
"Full access" token works too but grant the narrow scopes for real use.)

Note your coordinates (these are **not** secrets — they're in your repo URL):
`https://dev.azure.com/<ORG>/<PROJECT>` and the repo name `<REPO>`.

---

## 3. Put your credentials in `.baron/credentials`

Baron reads credentials from a **gitignored** file (or the environment) — never from the committed
policy, and you should **never paste your PAT into a chat**.

```bash
cd <your-project>
mkdir -p .baron
```

Create `<your-project>/.baron/credentials` (org/project/repo are coordinates; only the token is secret):

```
AZURE_DEVOPS_ORG=your-org
AZURE_DEVOPS_PROJECT=Your Project
AZURE_DEVOPS_REPO=your-repo
AZURE_DEVOPS_TOKEN=<paste-your-PAT-here>
```

`baron init`, `doctor`, `run`, and the MCP server all read this file (and let real environment
variables override it). Step 4 will also ensure `.baron/credentials` is gitignored.

---

## 4. `baron init` — introspect and confirm the mapping

This connects to your live project, reads its **actual** work-item states and types, and proposes a
role/type map for you to confirm. (It introspects live, which is why the credentials in step 3 come
first.)

```bash
cd <baron>
pnpm baron init --provider azure-devops --root <your-project>
```

You'll see a proposal like:

```
Proposed mapping for issues provider 'azure-devops':
  role backlog     -> {"state":"New"}
  role in_progress -> {"state":"Active"}
  role in_review   -> {"state":"Test"}
  role done        -> {"state":"Closed"}
  type epic  -> Epic
  type story -> Product Backlog Item
  type task  -> Task
Notes (confirm these guesses):
  - Mapped role 'in_review' to state 'Test' by name ...
```

**Read the notes and confirm the mapping is right for your process** — this is the one human step
Baron's design depends on. Common things to check:
- Does each workflow role map to the state you actually use? (e.g. is your review state really `Test`,
  or is it `Resolved` / `Code Review`?)
- Did `story` map to your story-level type (Scrum: **Product Backlog Item**; Agile: **User Story**) and
  not to `Feature`?
- Is `blocked` unmapped? That's fine — transitioning to an unmapped role errors loudly (by design);
  map it later if your process has a blocked state.

Confirm to write `<your-project>/.baron/policy.json`. init also scaffolds `.baron/credentials.example`
and adds `.baron/credentials` to your `.gitignore`.

> **Redoing an existing project (e.g. BeeMaster already has a `.baron/`):** to start clean, re-run with
> `--force` to overwrite the policy: `pnpm baron init --provider azure-devops --root <project> --force`.
> (Or move the existing `.baron/` aside first.)

---

## 5. `baron doctor` — validate against the live project

```bash
cd <baron>
pnpm baron doctor --root <your-project>
```

Expect: **`OK — N reference(s) checked for 'azure-devops', no drift.`** (exit 0). If it reports drift,
a state/type/column in your policy no longer matches the live project — fix `policy.json` and re-run.

---

## 6. (Optional) bind the other ports

`policy.json` binds `issues` by default. To use more ports, add them under `providers` (they reuse the
same Azure DevOps credentials — **no extra `baron init`**, since their status maps are built in):

```jsonc
{
  "providers": {
    "issues": "azure-devops",
    "scm": "azure-devops",      // branches + PRs (needs AZURE_DEVOPS_REPO + Code R&W on the PAT)
    "ci": "azure-devops",       // pipelines/runs/logs/trigger/cancel (Build R&E)
    "deploy": "azure-devops"    // environments + deployments
  },
  // ... roleMap / typeMap / gapPolicy from init stay as-is ...
}
```

Re-run `baron doctor` after editing. (A full reference policy lives in
[examples/azure-proof](../examples/azure-proof/.baron/policy.json).)

---

## 7. Wire the MCP server into Claude Code

Claude Code reads a project's `.mcp.json`. Create `<your-project>/.mcp.json`:

```jsonc
{
  "mcpServers": {
    "baron": {
      "command": "pnpm",
      "args": ["--dir", "<baron>", "baron:mcp"],
      "env": { "BARON_ROOT": "<your-project>" }
    }
  }
}
```

- `BARON_ROOT` points the server at this project, so it reads `<your-project>/.baron/policy.json` +
  `credentials` no matter where it runs.
- **Windows:** if Claude Code can't find `pnpm`, set `"command": "pnpm.cmd"`.
- **Once published:** replace `command`/`args` with `"command": "npx", "args": ["-y", "@lonca/baron-mcp-server@latest"]`
  (keep the `BARON_ROOT` env). The explicit `@latest` matters — a bare name makes `npx` reuse its
  cached install without re-checking the registry, silently pinning you to a stale version.
- **Restart Claude Code** (or reload MCP servers) so it picks up the new server. Confirm it started:
  running `pnpm baron:mcp` (with `BARON_ROOT` set) prints `baron mcp-server running on stdio (root: …)`
  to stderr, then waits — Ctrl-C to stop.

Claude will now see the `baron_*` tools for the bound ports (e.g. `baron_issue_*`, and `baron_scm_*` /
`baron_ci_*` / `baron_deploy_*` if you bound those), the always-on `baron_learning_*` /
`baron_followup_*`, and the labeled `baron_native_request` escape hatch.

---

## 8. First use — drive it from Claude

Ask in plain language; Claude picks the tools:

- *"Using Baron, list my backlog."* → `baron_issue_query { role: backlog }`
- *"Create a Baron task 'Try the issues port' and move it to in progress."* → `baron_issue_create` + `baron_issue_transition`
- *"Start a task 'X': create it, branch for it, move it to in progress."* → run the `task-start` recipe (issues + scm)
- *"Show my pipelines and the latest run's status."* → `baron_ci_pipelines` + `baron_ci_runs`
- *"Is PR 42 ready to merge?"* → `baron_scm_pr_status`

You can also run a packaged recipe directly:

```bash
pnpm baron run --recipe <baron>/packages/recipes/recipes/task-start.yaml --root <your-project>
```

Tip: to keep Claude using Baron (rather than a raw Azure DevOps MCP) for work-tracking, drop a short
`CLAUDE.md` in your project saying *"route work-tracking through the `baron_*` tools; use the raw
azure-devops MCP only for research Baron doesn't cover."*

---

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `POLICY_NOT_FOUND` | No `.baron/policy.json` at the root — run `baron init` (step 4), or check `BARON_ROOT`. |
| `401` / `403` from Azure | PAT missing or lacking a scope (step 2). For PRs you need Code R&W; for trigger/cancel, Build R&E. |
| `ROLE_MAPPING` on a transition | The target role (e.g. `blocked`) isn't mapped in `policy.json` — add it or pick a mapped role. Loud-by-design. |
| `doctor` reports drift | A state/type/column in `policy.json` no longer exists in the project — update the map. |
| Claude doesn't see `baron_*` tools | `.mcp.json` not picked up — restart Claude Code; on Windows try `pnpm.cmd`; confirm the server starts (step 7). |
| `baron_deploy_*` returns nothing | Your project uses pipeline stages, not Azure **Environments** — that's correct-empty, not an error. |
| A query returns a huge result | `baron_issue_query` defaults to 50 and is project-scoped + lean; pass a larger `limit` only if you need it. |

---

## 10. What's live-validated vs not

The Azure DevOps path (issues lifecycle, branches/PRs, ci read + trigger/cancel + stages, deploy reads,
scm pr-status, the escape hatch) has been exercised against a real project. GitHub and Slack adapters
are conformance-tested but not yet live-validated here. See
[trying-with-claude-code.md](./trying-with-claude-code.md) for a phased verification checklist you can
run after setup.
