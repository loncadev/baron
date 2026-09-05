# Setup walkthrough — Baron on Jira Cloud (from scratch)

A copy-paste walkthrough to wire Baron to a **Jira Cloud** project and drive it from **Claude Code**.
End state: you ask Claude *"start PROJ-12"* and it moves the issue through Jira's workflow, cuts the
branch on GitHub, and assigns the work to you — through one set of normalized tools.

> Written from a real run against a free Jira Cloud site with a team-managed Software project
> (statuses To Do / In Progress / In Review / Done; types Epic, Story, Task, Bug, Subtask). The
> commands, prompts and messages below are what actually appeared, not a reconstruction.

Jira is unlike every other provider Baron ships in one way that is worth knowing before you start:

- **A status cannot be set.** Jira's workflow permits some *transitions* from the issue's current
  status, each landing on one status, and a transition can carry a **screen** that demands fields —
  "Resolve" wanting a `resolution`, say. Baron reads both from Jira before every move: a move the
  workflow will not make is refused with `TRANSITION_NOT_PERMITTED` naming what it would, and a move
  whose screen wants answers is refused with `TRANSITION_FIELDS_REQUIRED` naming every field, which
  you pass back as `fields`. Nothing is written until both checks pass.
- **Its three categories cannot tell your roles apart.** Every Jira status is To Do, In Progress or
  Done, so `in_review` and `in_progress` look the same to the API. `baron init` proposes from status
  *names* and asks you to confirm.
- **There is no source control.** Jira fills the `issues` port and nothing else. Branches and pull
  requests come from elsewhere, and `baron init` offers to take them from the repository your git
  remote already names.

---

## 0. What you'll end up with

```
<your-project>/
  .baron/
    policy.json      # committed: providers, role map (by status NAME), type map, gap policy
    credentials      # gitignored: JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT (+ GITHUB_* for scm)
  AGENTS.md          # optional steering block that tells the agent to use Baron for work tracking
```

---

## 1. Prerequisites

- Node 20+ (`node --version`).
- A Jira Cloud site you can create issues in, and the **project key** — the prefix on its issue keys
  (`PROJ` in `PROJ-123`). A throwaway project is the right place to try this first.
- Optionally, a GitHub repository for branches and pull requests, plus a token for it —
  [Getting started](./getting-started.md) covers the token; `init` will ask for it if you accept
  the offer.

---

## 2. Create a Jira API token

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens> and create a token.
2. Note the **email** of the Atlassian account you created it under: the token is sent as HTTP
   Basic `email:token`. There is no Bearer form for an API token.
3. Make sure that account is a member of the project with the ordinary permissions — Browse
   Projects, Create Issues, Edit Issues, Transition Issues, Add Comments, Link Issues. Project
   defaults grant all of these.

`baron init` will ask for the token, the email, the site (`https://acme.atlassian.net`) and the
project key, and write them to `.baron/credentials`, which is gitignored. Nothing secret enters
`policy.json`.

---

## 3. `baron init` — introspect and confirm the mapping

From your project root:

```bash
npx -y @lonca/baron-cli@latest init --provider jira
```

It explains what it is about to do, offers to take branches and pull requests from the repository
your git remote names (Jira has none), gathers credentials, then reads your project's issue types
and the statuses their workflows can hold, and **proposes** a mapping. Nothing is written until you
confirm. On a team-managed project with the four default statuses the run looked like this:

```
Provider 'jira' has no source control. Take branches and pull requests from GitHub (loncadev/baron-live-test, read off your git remote)? (Y/n)
Setting up credentials → .baron/credentials (gitignored, never committed).
Jira Cloud needs an API token, the email it belongs to, the site, and a project key.
  1. Create the token at: https://id.atlassian.com/manage-profile/security/api-tokens
  2. JIRA_SITE is the site root, e.g. https://acme.atlassian.net
  3. JIRA_EMAIL is the Atlassian account the token was created under.
  4. JIRA_PROJECT is the project KEY, the prefix on its issue keys (PROJ in PROJ-123).
  JIRA_SITE:   JIRA_EMAIL:   JIRA_API_TOKEN (paste the token — input hidden):
  JIRA_PROJECT: Saved .baron/credentials (gitignored — your token is not committed).
Binding provider 'jira' to: issues.
Proposed mapping for issues provider 'jira':
  role backlog -> {"status":"To Do"}
  role in_progress -> {"status":"In Progress"}
  role in_review -> {"status":"In Review"}
  role done -> {"status":"Done"}
  type epic -> Epic
  type story -> Story
  type task -> Task
  type bug -> Bug
  type subtask -> Subtask
  type initiative -> Epic
  gap sprints -> degrade
Notes (confirm these guesses):
  - Mapped role 'in_review' to state 'In Review' by name (no 'resolved'-category state found); confirm it.
  - No native type matched type role 'initiative'; collapsed onto 'Epic'. Items of that native type no longer resolve back to a single role.
Write .baron/policy.json with this mapping? (Y/n)
Create AGENTS.md (agent steering for Baron)? (Y/n)
Wrote .baron/policy.json (commit it — it holds no secrets).
```

**Read the notes.** Jira reports only three status categories, so any status beyond To Do /
In Progress / Done was matched **by name** — a status called "In Review", "Code Review", "QA" or
"Testing" is proposed for `in_review`, and a project with none leaves the role unmapped. The
`initiative` collapse is the honest answer on a project without Jira Premium's extra hierarchy
level: it shares the Epic type, so an Epic read back reports `epic`. A role you map onto a status
the workflow cannot reach from where an issue is will be refused at transition time, by Jira's own
rules, with the permitted moves named.

If a guess is wrong, answer `n`, fix the workflow in Jira (or edit `policy.json` afterwards), and run
`init` again.

### Branches and pull requests

Jira has no source control, so `init` offers the repository your git remote points at for the `scm`
port. Accept, provide a GitHub token, and `task-start` cuts branches there while the issue moves in
Jira. Decline, and `scm.*` operations report `PORT_UNBOUND` — never a silent no-op.

---

## 4. `baron doctor` — validate against the live project

```bash
npx -y @lonca/baron-cli@latest doctor
```

```
OK — 10 reference(s) checked for 'jira', no drift.
OK — 2 credential capability/capabilities confirmed.
```

The references are every mapped status name and issue type. Rename a status in Jira's workflow
editor and this is what tells you, rather than a recipe failing later, far from the cause. The
credential check reads the project for `issues:read` and, for `issues:write`, attempts an edit on an
issue key that cannot exist (`PROJ-0`): a 404 proves the token was allowed to try without anything
being written.

---

## 5. Wire it into Claude Code

The simplest path is the plugin, which brings the MCP server *and* the skills:

```
/plugin marketplace add loncadev/baron
/plugin install baron@baron
```

To wire the server by hand instead, create `<your-project>/.mcp.json`:

```jsonc
{
  "mcpServers": {
    "baron": {
      "command": "npx",
      "args": ["-y", "@lonca/baron-mcp-server@latest"],
      "env": { "BARON_ROOT": "<your-project>" }
    }
  }
}
```

`BARON_ROOT` points the server at this project, so it reads that project's `policy.json` and
`credentials` wherever it runs. Restart Claude Code so it picks the server up.

---

## 6. First use

Ask Claude, or run the recipes yourself:

```bash
npx -y @lonca/baron-cli@latest run --recipe task-new     # file an issue in Jira
npx -y @lonca/baron-cli@latest run --recipe task-start   # move it, cut the branch, assign it
npx -y @lonca/baron-cli@latest run --recipe task-finish  # open a draft PR, link it on the issue
npx -y @lonca/baron-cli@latest run --recipe task-land    # undraft, wait for checks, merge
```

A recipe that creates an item and walks it through every hop ran like this on the real project —
each transition is checked against the transitions Jira permits from where the item is, and each
landed:

```
created KAN-2 type=Task role=backlog branch=task/kan-2-baron-live-walk-safe-to-delete
assigned to kemreparlak@gmail.com
final role=done url=https://kadiremresworkspace-36668184.atlassian.net/browse/KAN-2
```

The branch name carries the issue key, which is what a person calls the issue and what every Jira
endpoint accepts. With GitHub bound to `scm`, `task-start` reports both halves:

```
KAN-12 is in progress on task/kan-12-add-the-webhook (created on the provider), assigned to you.
Your working copy has not moved. To get onto it:
  git fetch && git checkout task/kan-12-add-the-webhook
```

### When a transition asks for fields

Closing an issue on many Jira workflows runs a "Resolve" transition whose screen requires a
resolution. Baron refuses **before** writing and says exactly what it needs:

```
TRANSITION_FIELDS_REQUIRED: Provider 'jira' needs more to move this item to role 'done':
'resolution' (one of: Fixed, Won't Do). Pass them as 'fields'.
```

The same list rides in `structuredContent.details.fields` for an agent to read. Answer with the
field in the shape Jira wants it — for a resolution that is an object with a name:

```jsonc
// MCP
baron_issue_move { "op": "transition", "id": "PROJ-12", "role": "done",
                   "fields": { "resolution": { "name": "Fixed" } } }
```

```yaml
# recipe
- do: issue.transition
  with: { id: "${issue.id}", role: done, fields: { resolution: { name: Fixed } } }
```

Baron checks that every required field is present and passes the values through untouched; what a
field means, and whether a value is acceptable, stays Jira's.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `HTTP 401` on every call | Wrong email/token pair, or the token was sent as a Bearer. An API token goes in HTTP Basic with the account email. |
| `no project 'PROJ' is visible to this token` | Wrong key, or the account is not a member of the project. Jira answers 404 for both and does not say which. |
| `POLICY_NOT_FOUND` | No `.baron/policy.json` at the root — run `init`, or check `BARON_ROOT`. |
| `TRANSITION_NOT_PERMITTED` | The workflow has no transition from the issue's current status to the mapped one. The message lists what it permits; move through an intermediate role, or adjust the workflow. |
| `TRANSITION_FIELDS_REQUIRED` | The transition's screen wants fields. Pass them as `fields`, keyed exactly as named (see §6). |
| `PORT_UNBOUND` on `scm.branch.create` | `providers.scm` is unbound, because Jira provides no source control. Re-run `init` and accept the GitHub offer. |
| `LINK_MAPPING` for `blocked_by` | Jira links are directional and named from the outward side; write "A is blocked by B" as `blocks` from B to A. |
| Sprints do nothing | Sprints live on the Jira Software agile API and are not wired yet; the manifest declares it and the gap policy (`degrade` by default) decides. |

---

## 8. What's live-validated

Run against a real team-managed Jira Cloud project: introspection, `baron init` with prompted
credentials, `doctor` (reference check and both credential probes), and a recipe walk — create,
assign `@me`, `in_progress` → `in_review` → `done` through Jira's transitions, comment, query by
role, delete. The gated smoke test repeats the transport-level half whenever `JIRA_SITE`,
`JIRA_EMAIL`, `JIRA_API_TOKEN` and `JIRA_PROJECT` are present in the environment.

Two things were **not** exercised live, and are covered by tests that assert what the transport
sends instead: a transition **screen** (the default team-managed workflow attaches none, so
`TRANSITION_FIELDS_REQUIRED` and the `fields` reply are proven against Jira's documented
`transitions` shape rather than a real screen), and a workflow that refuses a hop (the default
workflow permits every status from every other). Sprints are not supported yet. See
[providers.md](./providers.md) for the full capability table.
