# CLI

The `baron` command has three subcommands. All side effects go through the policy in the current
directory's `.baron/` (override the root with `--root`). Run it via `npx -y @lonca/baron-cli@latest …`,
or from a clone of this repo with `pnpm baron …` (a `tsx` runner is wired up).

```
baron init --provider <id> [--root <dir>] [--force]
baron doctor [--root <dir>]
baron run --recipe <path> [--root <dir>]
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

Exit `0` = no drift; exit `1` = drift found (each item is listed) or an error.

## `baron run`

Load the policy, build its live ports (issues / scm) plus the local knowledge loop, load a YAML
recipe, and execute it. `ask` steps prompt on stdin; `message` steps print to stdout.

| Flag | Meaning |
| --- | --- |
| `--recipe <path>` | **Required.** Path to the recipe YAML file. |
| `--root <dir>` | Project root (default `.`). |

Missing `--recipe` exits `2`. See [Recipes](./recipes.md).

## Exit codes & errors

- `0` success · `1` error or drift · `2` usage error (missing required flag).
- A `BaronError` is printed as `error [CODE]: message` — the code is stable and branchable, e.g.
  `POLICY_NOT_FOUND`, `POLICY_PARSE`, `CAPABILITY_GAP`, `ROLE_MAPPING`, `UNKNOWN_PROVIDER`,
  `RECIPE_NOT_FOUND`. Any other failure prints `error: message`. Nothing is ever a silent no-op.
