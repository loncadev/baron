# Providers

Baron ships two P0 providers. Each contributes a capability manifest per port; the core reads it and
applies your gap policy for anything a provider can't do natively. This page is the support matrix.

## Ports × providers

| Port | Azure DevOps | GitHub | Slack |
| --- | --- | --- | --- |
| `issues` | ✅ Azure Boards | ✅ GitHub Issues | — |
| `scm` | ✅ Azure Repos | ✅ GitHub (git refs + pulls) | — |
| `ci` | ✅ Azure Pipelines | ✅ GitHub Actions | — |
| `deploy` | ✅ Azure Environments | ✅ GitHub Environments | — |
| `notify` | — | — | ✅ Slack |
| `docs` | — (planned, v2) | — (planned, v2) | — (planned, v2) |

Every provider also exposes the **escape hatch** (`baron_native_request`, ARCHITECTURE decision #18):
a clearly-labeled, last-resort, non-portable raw authenticated REST call. It only reaches providers
your policy already binds — prefer the normalized tools above. The `docs` port is declared but not yet
implemented (v2); binding `policy.providers.docs` throws `DOCS_UNSUPPORTED`.

`ci` and `deploy` reuse the **same** credentials/coordinates as `issues`/`scm` on that provider — no
extra env keys and no `baron init` step, because the status maps below are vendor-fixed adapter
knowledge, not user-confirmed roles. `notify` (Slack) uses `SLACK_BOT_TOKEN` + `SLACK_CHANNEL`.

## Issues capabilities

| Capability | Azure DevOps | GitHub | If absent, default handling |
| --- | --- | --- | --- |
| `hierarchy` (native parent/child) | ✅ | ❌ | `emulate:labels` (`parent:<id>`) |
| `arbitraryStates` (beyond open/closed) | ✅ | ❌ | `emulate:labels` (mid-roles ride labels) |
| `separateBoardColumn` | ✅ | ❌ | n/a |
| `sprints` | ✅ | ❌ | `degrade` |
| `nativeLabels` | ✅ | ✅ | — |
| `comments` | ✅ | ✅ | — |
| `issueLinks` (typed links) | ✅ | ❌ | `emulate:labels` (`<type>:<id>`) |

GitHub's flatness is the point: the same `issue.create` / `transition` produce correct-but-different
behavior, and every gap is negotiated explicitly — never silent. The recommended GitHub gap policy
(`baron init` proposes it) emulates hierarchy / arbitrary states / links via labels and degrades
sprints.

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
(`@baron/conformance`); live behavior is covered by credential-gated smoke tests.
