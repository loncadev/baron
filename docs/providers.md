# Providers

Each provider contributes a capability manifest per port; the core reads it and applies your gap
policy for anything a provider can't do natively. This page is the support matrix.

## Ports × providers

| Port | Azure DevOps | GitHub | Jira | Linear | Slack |
| --- | --- | --- | --- | --- | --- |
| `issues` | ✅ Azure Boards | ✅ GitHub Issues | ✅ Jira Cloud | ✅ Linear Issues | — |
| `scm` | ✅ Azure Repos | ✅ GitHub (git refs + pulls) | — | — | — |
| `ci` | ✅ Azure Pipelines | ✅ GitHub Actions | — | — | — |
| `deploy` | ✅ Azure Environments | ✅ GitHub Environments | — | — | — |
| `notify` | — | — | — | — | ✅ Slack |
| `docs` | — (planned, v2) | — (planned, v2) | — (planned, v2) | — (planned, v2) | — (planned, v2) |

Jira and Linear bind `issues` only: neither has source control, pipelines or environments of its
own, which is exactly the case ports exist for — pair either with GitHub for `scm` and nothing about
the recipes changes.

Every provider also exposes the **escape hatch** (`baron_native_request`, ARCHITECTURE decision #18):
a clearly-labeled, last-resort, non-portable raw authenticated REST call. It only reaches providers
your policy already binds — prefer the normalized tools above. The `docs` port is declared but not yet
implemented (v2); binding `policy.providers.docs` throws `DOCS_UNSUPPORTED`.

`ci` and `deploy` reuse the **same** credentials/coordinates as `issues`/`scm` on that provider — no
extra env keys and no `baron init` step, because the status maps below are vendor-fixed adapter
knowledge, not user-confirmed roles. `notify` (Slack) uses `SLACK_BOT_TOKEN` + `SLACK_CHANNEL`.

## Issues capabilities

| Capability | Azure DevOps | GitHub | Jira | Linear | If absent, default handling |
| --- | --- | --- | --- | --- | --- |
| `hierarchy` (native parent/child) | ✅ | ❌ | ✅ | ✅ | `emulate:labels` (`parent:<id>`) |
| `arbitraryStates` (beyond open/closed) | ✅ | ❌ | ✅ | ✅ | `emulate:labels` (mid-roles ride labels) |
| `separateBoardColumn` | ✅ | ❌ | ❌ | ❌ | n/a |
| `sprints` | ✅ | ❌ | ❌ (not yet) | ✅ (cycles) | `degrade` |
| `nativeLabels` | ✅ | ✅ | ✅ | ✅ | — |
| `nativeTypes` (a type is stored at create and read back) | ✅ | ❌ | ✅ | ❌ | the role rides a `type:<role>` label |
| `typeFiltering` (the provider's query filters by type) | ✅ | ❌ | ✅ (JQL) | ❌ | `emulate:post-filter` |
| `comments` | ✅ | ✅ | ✅ | ✅ | — |
| `issueLinks` (typed links) | ✅ | ❌ | ✅ | ✅ | `emulate:labels` (`<type>:<id>`) |

**Jira is the first provider that GATES transitions.** A status cannot be set: the workflow permits
some transitions from the issue's current status, and a transition may carry a screen that demands
fields (`resolution` on "Resolve", say). The adapter reports both — reachable targets and required
fields — from Jira's `transitions` read, and the core verifies against them *before* writing: a move
the workflow will not make fails with `TRANSITION_NOT_PERMITTED` naming what it would, and a move
whose screen wants answers fails with `TRANSITION_FIELDS_REQUIRED` naming every field, which the
caller passes back as `fields` (`baron_issue_move { op: "transition", fields: { resolution: { name:
"Fixed" } } }`, or `fields:` on a recipe's `issue.transition`). The role map keys on the status
*name*; Jira's own three categories (To Do / In Progress / Done) cannot tell `in_review` from
`in_progress`, so `baron init` proposes from names and a human confirms. Sprints live on the Jira
Software agile API and are not wired yet — the manifest says so, and the gap policy decides
(`degrade` by default). Issue links are directional and named from the outward side, so
`blocked_by` is deliberately unmapped: write "A is blocked by B" as `blocks` from B to A.

**Linear is the first provider whose states are SCOPED.** A `WorkflowState` belongs to a team, not to
the workspace, so the same role is a different state in each team — `in_progress` is one id in one
team and another id in another, even where both are named "In Progress". Its role map is therefore
written per team (`policy.roleMap.linear.scopes.<TEAM>`), `baron init` proposes one map per team, and
a role can legitimately exist in one team and not another. Nothing else in the model changes: recipes
still speak roles.

Linear also has no work-item types at all — an issue is an issue — so the type role rides a label
exactly as it does on GitHub.

GitHub's flatness is the point: the same `issue.create` / `transition` produce correct-but-different
behavior, and every gap is negotiated explicitly — never silent. The recommended GitHub gap policy
(`baron init` proposes it) emulates hierarchy / arbitrary states / links via labels, post-filters
type queries, and degrades sprints.

Two of those gaps exist because GitHub has no work-item type Baron can write: `POST /issues` accepts
none, so an item created through Baron reads back untyped whatever the type map says. The type role
survives on a `type:<role>` label, and a query filtered by type role is filtered by Baron rather than
by GitHub. Without a `typeFiltering` policy that query is **refused**, not answered with everything.

### Known provider quirks

- **GitHub cold reads:** a fresh `issue.get` reports open/closed only; a mid-workflow role is
  recovered on the write path (the transport must not hold the role map). Reverse type-role
  resolution is likewise lossy when every type role maps to the single `issue` type.
- **Azure board column:** moving a card's column writes the per-board hidden
  `WEF_<guid>_Kanban.Column` field discovered at runtime (`System.BoardColumn` is read-only);
  multi-board projects can expose several — provider-quirky, validated under live smoke.

## Scm capabilities

| Capability | Azure DevOps | GitHub |
| --- | --- | --- |
| `draftPullRequests` | ✅ | ✅ |
| `pullRequestThreads` | ✅ (native threads) | ✅ (PR-level comment) |

A requested `draft` on a provider without draft support is gap-negotiated (degrade → open a ready PR
+ warn), never silently downgraded.

**What a PR's checks are** differs by provider, and the normalized rollup hides the difference: on
GitHub they are check runs and commit statuses; on Azure they are **branch-policy evaluations**,
which live on a separate (preview) API. Either way `unknown` means Baron could not read them and
`none` means it read them and there are none — a distinction `task-land` depends on, since it warns
on the first and proceeds quietly on the second.

## Ci capabilities

| Capability | Azure Pipelines | GitHub Actions |
| --- | --- | --- |
| `canTrigger` | ✅ | ✅ |
| `canCancel` | ✅ | ✅ |
| `hasStages` (per-stage status in run detail) | ✅ | ✅ |
| `hasApprovalGates` | ✅ | ✅ |
| `providesLogs` (size-aware tail) | ✅ | ✅ |
| `hasArtifacts` | ✅ | ✅ |

Azure Pipelines is validated live; GitHub Actions is conformance-tested.

## Status normalization

Both `ci` and `deploy` collapse each provider's native phase + result into one normalized status, so
recipes branch on a single vocabulary instead of vendor-specific state machines.

- **`RunStatus`** (ci): `queued | running | succeeded | failed | canceled | skipped | waiting |
  unknown`. Per-stage status carries the same vocabulary in the run detail; logs are a size-aware
  tail.
- **`DeployStatus`** (deploy): `pending | running | succeeded | failed | canceled | skipped |
  unknown`.

## Adding a provider

A new provider (Jira, Linear, GitLab, …) is a thin adapter: a `CapabilityManifest` + an
`IssuesTransport` (and/or `ScmTransport`) doing provider I/O only — no role/native translation, which
stays in the shared core. Every adapter must pass the network-free conformance suite
(`@lonca/baron-conformance`); live behavior is covered by credential-gated smoke tests.

Two optional transport methods exist for a provider that **gates transitions** the way Jira does,
where a status cannot simply be set:

- `availableTargets(id)` — the targets the item can reach from where it is now. The core checks the
  mapped target is among them and refuses with `TRANSITION_NOT_PERMITTED` otherwise, naming what the
  provider would accept. It verifies; it never picks — the map a human confirmed decides what a role
  means.
- `transitionFields(id, target)` — the fields the move's screen demands (`resolution`,
  `fixVersions`), each with `required` and any `allowedValues`. The core refuses with
  `TRANSITION_FIELDS_REQUIRED` before writing when a required one is missing from the caller's
  `fields`, and otherwise hands `fields` to `applyTarget` untouched. The transport reports and
  applies; it never interprets a role, and the core never interprets a field.

A Jira transport answers both from one `GET /issue/{id}/transitions?expand=transitions.fields` and
performs the move with `POST …/transitions`. A provider that gates nothing implements neither.
