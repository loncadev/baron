# Configuration

Baron's configuration is one committed file — `.baron/policy.json` — plus credentials that live
outside it. `baron init` writes the policy for you; this page documents what it contains so you can
read and hand-edit it.

## `.baron/policy.json`

Policy only — **never secrets**. A full example:

```json
{
  "version": 1,
  "providers": {
    "issues": "azure-devops",
    "scm": "azure-devops",
    "ci": "azure-devops",
    "deploy": "azure-devops",
    "notify": "slack"
  },
  "roleMap": {
    "azure-devops": {
      "stateKey": "state",
      "states": {
        "backlog": { "state": "New" },
        "in_progress": { "state": "Active", "boardColumn": "In Progress" },
        "in_review": { "state": "Test", "boardColumn": "Test" },
        "done": { "state": "Closed" }
      }
    }
  },
  "typeMap": {
    "azure-devops": { "epic": "Epic", "story": "Product Backlog Item", "task": "Task" }
  },
  "gapPolicy": {
    "github": { "hierarchy": "emulate:labels", "sprints": "degrade" }
  },
  "language": { "interaction": "en", "artifacts": "en" }
}
```

### Fields

- **`version`** — schema version (currently `1`).
- **`providers`** — binds each port to a provider id: `issues`, `scm`, `ci`, `deploy`, `notify`,
  `docs`. A port you don't bind simply isn't available. `ci` and `deploy` reuse the
  `issues`/`scm` credentials and coordinates — no extra env keys and no `baron init` step, because
  their status maps are vendor-fixed adapter knowledge, not user-confirmed. Binding `docs` is not yet
  supported (v2) and throws `DOCS_UNSUPPORTED`.
- **`roleMap`** — keyed by provider id. Each entry has a `stateKey` (which native target key the
  reverse role lookup is keyed on — Azure `state`, GitHub `label`) and `states`: a map of workflow
  role → native target (a flat string map, e.g. `{ "state": "Active", "boardColumn": "In Progress" }`
  or `{ "label": "in-progress" }`).
- **`typeMap`** — keyed by provider id: type role → native work-item type name. A provider with one
  native type (GitHub) maps every role onto it (reverse resolution is lossy — noted by `init`).
- **`gapPolicy`** *(optional)* — keyed by provider id: capability name → behavior string
  (`error` | `degrade` | `emulate:<strategy>`). Absent ⇒ `error` (strict). See
  [Concepts → capability gaps](./concepts.md#3-capability-gaps-are-never-silent).
- **`language`** *(optional)* — `interaction` (prompts) and `artifacts` (committed text) languages.

A malformed or structurally-invalid policy fails loudly with a coded `POLICY_PARSE` /
`ROLE_MAP_MISSING` / … error — never a silent default.

> **Note:** link-type→native mapping (`relates` → `System.LinkTypes.Related`, …) is *fixed provider
> knowledge*, not install config, so it's supplied by the adapter and not part of `policy.json`.

## Credentials

Credentials never live in `policy.json`. The CLI and MCP server read them from the environment,
overlaid by a gitignored `.baron/credentials` file (`KEY=VALUE` lines; `#` comments allowed) when
present — a real environment variable wins over the file. `baron init` scaffolds
`.baron/credentials.example` and gitignores the real file.

| Provider | Keys |
| --- | --- |
| Azure DevOps | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_REPO` (scm), `AZURE_DEVOPS_TOKEN` |
| GitHub | `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` |
| Slack (notify) | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL` |

Example `.baron/credentials` (never committed):

```
AZURE_DEVOPS_ORG=beekod
AZURE_DEVOPS_PROJECT=BeeMaster
AZURE_DEVOPS_REPO=BeeMaster
AZURE_DEVOPS_TOKEN=<your-pat>
```

## One target per install (and how to do "multi")

A single `.baron/policy.json` (in one workspace) targets **one** Azure DevOps org/project (issues) +
**one** repo (scm), because the coordinates come from that workspace's environment. To work across
many projects today, give each repo/workspace its own `.baron/policy.json` and credentials — Baron
is workspace-scoped, so this just works.

> Roadmap: org/project/repo are coordinates, not secrets (they're already in your git remote), so a
> planned refinement moves them into `policy.json` and keeps only the token in the environment —
> making a policy fully self-describing and easing multi-target setups. Single-process multi-tenancy
> (one server driving N orgs) is a larger, later feature.

## `baron doctor`

`doctor` re-introspects the live provider and reports drift between the policy and reality (a mapped
native state / type / board column that no longer exists). Run it after a provider's process
template changes. Label-discriminated providers (GitHub) skip native-state checks (labels are
Baron-managed).
