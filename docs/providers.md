# Providers

Baron ships two P0 providers. Each contributes a capability manifest per port; the core reads it and
applies your gap policy for anything a provider can't do natively. This page is the support matrix.

## Ports × providers

| Port | Azure DevOps | GitHub |
| --- | --- | --- |
| `issues` | ✅ Azure Boards | ✅ GitHub Issues |
| `scm` | ✅ Azure Repos | ✅ GitHub (git refs + pulls) |
| `notify` / `docs` | — (planned) | — (planned) |

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

## Adding a provider

A new provider (Jira, Linear, GitLab, …) is a thin adapter: a `CapabilityManifest` + an
`IssuesTransport` (and/or `ScmTransport`) doing provider I/O only — no role/native translation, which
stays in the shared core. Every adapter must pass the network-free conformance suite
(`@baron/conformance`); live behavior is covered by credential-gated smoke tests.
