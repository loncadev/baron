# CLI

The `baron` command has three subcommands. All side effects go through the policy in the current
directory's `.baron/` (override the root with `--root`). Run it via `npx -y @lonca/baron-cli@latest …`,
or from a clone of this repo with `pnpm baron …` (a `tsx` runner is wired up).

```
baron init --provider <id> [--root <dir>] [--force]
baron doctor [--root <dir>]
baron run --recipe <name-or-path> [--root <dir>]
baron run --resume <runId> [--root <dir>]
baron help
```

Known provider ids: `azure-devops`, `github`.

## `baron init`

One-command setup. In order, `init`:

1. **Gathers credentials.** Any key the provider needs that isn't already set (env or an existing
   `.baron/credentials`) is collected: GitHub `owner`/`repo` are auto-detected from the git `origin`
   remote, and the rest are prompted — tokens/PATs entered **hidden**. The values are written to
   `.baron/credentials` and the file is gitignored. A blank required key fails with `CREDENTIALS_MISSING`.
2. **Introspects** the provider, **proposes** a role/type/gap mapping, and asks you to confirm.
3. **Writes `.baron/policy.json`**, binding the provider to both `issues` **and** `scm` (when it has
   an scm adapter — both P0 providers do), so the branch/PR flow works without hand-editing.
4. **Provisions the workflow labels** on providers whose roles ride labels (GitHub): it creates
   `in-progress` / `in-review` / `done` with deliberate colors, so a transition never depends on the
   provider auto-creating a grey, description-less label. A no-op on native-state providers (Azure),
   and best-effort — if it can't reach the provider, it warns and the labels are created on first use.

| Flag | Meaning |
| --- | --- |
| `--provider <id>` | **Required.** Provider to bind. |
| `--root <dir>` | Project root (default `.`). |
| `--force` | Overwrite an existing `policy.json` without prompting. |

Missing `--provider` exits `2`. Declining the confirmation writes nothing and exits `0`. A mixed
setup (issues one provider, scm another) is reachable by editing `providers` in the written file.

## `baron doctor`

Load `.baron/policy.json`, introspect the live provider, and report drift (a mapped native state /
type / board column that no longer exists).

| Flag | Meaning |
| --- | --- |
| `--root <dir>` | Project root (default `.`). |

Also asks each bound provider's credential what it can actually do, because a policy that maps
cleanly onto a provider says nothing about whether your token may write to it.

Exit `0` = nothing wrong: no drift, nothing the credential is refused, and any capability that could
not be checked is printed rather than assumed. Exit `1` = drift, a **denied** capability (the
provider refused — the message names the permission to grant), or a probe that **broke** (the check
itself failed, so nothing was verified).

The last two are separated on purpose. A provider with no probe at all is a limitation, prints under
*Unconfirmed*, and stays green — an Azure install is correctly configured and must not be called
broken. A probe that ran and threw is different: something is wrong, and leading with OK would hand
CI a green light for a credential nobody checked.

## `baron run`

Load the policy, build its live ports (issues / scm) plus the local knowledge loop, load a YAML
recipe, and execute it. `ask` steps prompt on stdin; `message` steps print to stdout.

| Flag | Meaning |
| --- | --- |
| `--recipe <name-or-path>` | **Required.** A built-in or project recipe **name** (`task-start`), or a **path** to a YAML file. A value containing a separator or ending in `.yaml`/`.yml` is treated as a path, so a mistyped path is reported as a missing file rather than an unknown recipe. Names resolve exactly as they do over MCP. |
| `--resume <runId>` | Continue a run that stopped, from its journal under `.baron/runs/`: inputs and answers are restored, completed steps are replayed rather than repeated. `--recipe` is not needed — the journal names the recipe. |
| `--root <dir>` | Project root (default `.`). |

Every run is journaled and reports its id (`Run id: …`); a failed run prints the exact `--resume`
command. Missing both `--recipe` and `--resume` exits `2`. See
[Recipes — when a run fails halfway](./recipes.md#when-a-run-fails-halfway).

## Exit codes & errors

- `0` success · `1` error or drift · `2` usage error (missing required flag).
- A `BaronError` is printed as `error [CODE]: message` — the code is stable and branchable, e.g.
  `POLICY_NOT_FOUND`, `POLICY_PARSE`, `CAPABILITY_GAP`, `ROLE_MAPPING`, `UNKNOWN_PROVIDER`,
  `RECIPE_NOT_FOUND`. Any other failure prints `error: message`. Nothing is ever a silent no-op.
