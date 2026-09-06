# Setup walkthrough — Baron on Linear (from scratch)

A copy-paste walkthrough to wire Baron to a **Linear** workspace and drive it from **Claude Code**.
End state: you ask Claude *"start BAR-12"* and it moves the issue in Linear, cuts the branch on
GitHub, and assigns the work to you — through one set of normalized tools.

> Written from a real run against a real Linear workspace with two teams. The commands, prompts and
> messages below are what actually appeared, not a reconstruction.

Linear is the most interesting provider Baron ships, and the reasons are worth knowing before you
start rather than after one of them surprises you:

- **Workflow states belong to a team.** Two teams each have an "In Progress" and they are different
  rows. So the role map is written **per scope** (per team key), and a state is identified by its id
  rather than its name.
- **There are no work-item types.** An issue is an issue. Every type role (`task`, `bug`, `story`, …)
  rides a label, and reverse-resolving a type from an issue is lossy — Baron says so out loud.
- **There is no source control.** Linear fills the `issues` port and nothing else. Branches and pull
  requests come from elsewhere, and `baron init` offers to take them from the repository your git
  remote already names.

---

## 0. What you'll end up with

- `<your-project>/.baron/policy.json` — committed. The confirmed role map, per team.
- `<your-project>/.baron/credentials` — gitignored. Your Linear API key and, for branches, a GitHub
  token. **Never committed.**
- `<your-project>/.mcp.json` — tells Claude Code to launch Baron's MCP server for this project (not
  needed if you install the plugin instead).

---

## 1. Prerequisites

- **Node ≥ 20**.
- A **Linear workspace** you can administer, and the **team key** — the prefix on its issue ids
  (`BAR` in `BAR-12`).
- **Claude Code** (CLI, desktop, or IDE extension).
- Optional but recommended: a **GitHub repo** as your project's `origin`, so branches and PRs work.

Everything below uses `npx -y @lonca/baron-cli@latest`. The explicit `@latest` matters: a bare name
makes `npx` reuse a cached install without re-checking the registry, silently pinning you to a stale
version.

---

## 2. Credentials: sign in, or create a Linear API key

The default is to sign in through the browser during `init` — see the next section — and then
there is nothing to create here. If you would rather hold a personal key (narrower than any OAuth
scope, and the right choice for a CI account): Settings → **Security & access** → **Personal API
keys** → create one, and copy it.

> **The one trap worth naming.** A personal API key is sent as a bare `Authorization: <key>` header.
> `Bearer` is for OAuth access tokens only, and using it with a personal key fails as
> *"authentication required"* — which reads exactly like a bad key. Baron gets this right; you only
> meet it if you call the API yourself.

You do not have to create the key before running `init` — decline the browser sign-in and it asks
for the key (hidden) and the team, and writes them to the gitignored credentials file. Creating it
first just means you have it ready to paste.

---

### Browser sign-in instead of a key

Linear supports the OAuth authorization-code flow with PKCE, so `baron init` signs you in through
the browser instead of asking for a key, through Baron's own public Linear application ("Baron",
by Lonca). Nothing to register: `init` offers

```
Sign in to linear in your browser instead of pasting a token? (Y/n)
  Open https://linear.app/oauth/authorize?… and approve — Baron is listening for the answer.
```

Baron listens on the fixed port `41765`, because Linear matches the redirect URI against the
application's registered list character for character, port included. To use your own OAuth
application instead (Settings → API → OAuth applications), set `BARON_LINEAR_CLIENT_ID` to its
client id and register **exactly** `http://127.0.0.1:41765/callback` as its redirect URI — a
port-less `http://127.0.0.1/callback` is refused with *"Invalid redirect_uri parameter for the
application"*. If that port is taken on your machine, set `BARON_LINEAR_CALLBACK_PORT` to a free
one; with your own application, register `http://127.0.0.1:<port>/callback` as well. Set
`BARON_LINEAR_CLIENT_ID` to empty to turn the offer off and always paste a key.

No client secret is involved: PKCE binds the token exchange to the process that started the flow.
The access token Linear issues lasts 24 hours; the refresh token, its expiry and the client id are
stored beside it in `.baron/credentials`, and the transport renews the token before it expires (or
when Linear refuses it) and writes the rotated pair back — so a sign-in outlasts the day. When
Linear will not renew (revoked in Linear's settings), the error says to run `init` again.


## 3. `baron init` — introspect and confirm the mapping

From your project root:

```bash
npx -y @lonca/baron-cli@latest init --provider linear
```

It explains what it is about to do, gathers credentials, then reads your workspace and **proposes** a
mapping. Nothing is written until you confirm. On a two-team workspace the proposal looks like this:

```
Binding provider 'linear' to: issues, with scm (branches/PRs) on 'github'.
Proposed mapping for issues provider 'linear':
  scope BAR:
    role backlog -> {"stateId":"07d591da-…"}
    role in_progress -> {"stateId":"2e9b8701-…"}
    role in_review -> {"stateId":"7734c0b5-…"}
    role done -> {"stateId":"6b8061e3-…"}
  scope KSP:
    role backlog -> {"stateId":"c77dca2f-…"}
    role in_progress -> {"stateId":"fdbc8d47-…"}
    role done -> {"stateId":"d8ac1e7f-…"}
  type task -> Issue
  gap typeFiltering -> emulate:post-filter
Notes (confirm these guesses):
  - Mapped role 'in_review' to state 'Code Review' in scope 'BAR' by name (no 'resolved'-category
    state found); confirm it.
  - No 'resolved'-category state found for role 'in_review' in scope 'KSP'; left unmapped.
  - States are scoped on 'linear', so the map is per scope (BAR, KSP). A role can legitimately exist
    in one scope and not another.
  - Provider 'linear' exposes one native type ('Issue'); all type roles collapse onto it (reverse
    type-role resolution is lossy).
```

**Read the notes.** They are the guesses, and they are the whole reason you are asked to confirm:

- A role mapped **by name** was matched on a hunch. Linear's state `type` field is an open
  vocabulary — the live API returns values that no published list contains — so Baron will not
  silently decide a role from it.
- A role **left unmapped in one scope** is not a fault. A team with no review column cannot hold an
  in-review issue. Baron reports that when you query the role, instead of handing back an unfiltered
  list that looks exactly like a match.

If a guess is wrong, answer `n`, fix the state in Linear (or edit `policy.json` afterwards), and run
`init` again.

### Branches and pull requests

Linear has no source control, so `init` asks:

```
Provider 'linear' has no source control. Take branches and pull requests from GitHub
(acme/widgets, read off your git remote)? (Y/n)
```

Yes writes `providers: { "issues": "linear", "scm": "github" }` and gathers the GitHub credentials in
the same pass. No gives you an issues-only install, and the first recipe that needs a branch stops
with `PORT_UNBOUND` and names the key to set.

`init` also creates the labels Baron needs (`type:task`, `type:bug`, …) workspace-wide rather than
attached to one team. It never touches your existing issues.

---

## 4. `baron doctor` — validate against the live workspace

```bash
npx -y @lonca/baron-cli@latest doctor
```

```
OK — 13 reference(s) checked for 'linear', no drift.
OK — 2 credential capability/capabilities confirmed.
```

The count is worth reading: it is every mapped state in **every scope**, plus the type roles. If a
team renames a workflow state, this is what tells you — by name and by scope — rather than a recipe
failing later, far from the cause.

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
npx -y @lonca/baron-cli@latest run --recipe task-new     # file an issue in Linear
npx -y @lonca/baron-cli@latest run --recipe task-start   # move it, cut the branch, assign it
npx -y @lonca/baron-cli@latest run --recipe task-finish  # open a draft PR, link it on the issue
npx -y @lonca/baron-cli@latest run --recipe task-land    # undraft, wait for checks, merge
```

`task-start` on a Linear issue with GitHub bound to `scm` reports both halves:

```
BAR-12 is in progress on task/bar-12-add-the-webhook (created on the provider), assigned to you.
Your working copy has not moved. To get onto it:
  git fetch && git checkout task/bar-12-add-the-webhook
```

The branch carries `bar-12`, the reference a human reads — not the 36-character UUID that identifies
the issue inside Linear's API.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `authentication required` | The key is being sent as `Bearer`. A Linear personal key goes in a bare `Authorization` header. |
| `POLICY_NOT_FOUND` | No `.baron/policy.json` at the root — run `init`, or check `BARON_ROOT`. |
| `ROLE_MAPPING … in scope 'KSP'` | That role has no state in that team. Add one in Linear and re-run `init`, or use a role the team has. |
| `ROLE_SCOPE_UNKNOWN` | The issue is in a team added after `init` ran. Re-run `init` to pick it up — Baron will not fall back to another team's state. |
| `PORT_UNBOUND` on `scm.branch.create` | `providers.scm` is unbound, because Linear provides no source control. Re-run `init` and accept the GitHub offer. |
| `TRANSITION_NOT_PERMITTED` | Linear refuses that move from the issue's current state. The message lists what it does permit. |
| A query by role returns nothing | Read the warning: a role unmapped in some scope is reported, never silently skipped. |

---

## 8. What's live-validated

The Linear issues path — create, transition, assign, comment, label, link, query by role, and the
per-team scoped role map — is exercised against a real workspace by gated smoke tests, which run only
when `LINEAR_API_KEY` and `LINEAR_TEAM` are present in the environment. The mixed setup this
walkthrough describes (issues on Linear, branches and pull requests on GitHub) was run end to end
while writing it. The browser sign-in was run live against a registered Linear OAuth application:
`init` approving in the browser and writing the refresh token beside the access token; `doctor` on
that token; a renewal before expiry, a renewal after Linear refused a bad access token, and a
steady-state run that rotated nothing — each time with the rotated pair written back by the MCP
server and by `baron run`. See [providers.md](./providers.md) for the full capability table.
