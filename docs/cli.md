# CLI

The `baron` command has three subcommands. All side effects go through the policy in the current
directory's `.baron/` (override the root with `--root`). Run from this repo with
`pnpm dlx tsx packages/cli/src/bin.ts …` until the package is published.

```
baron init --provider <id> [--root <dir>] [--force]
baron doctor [--root <dir>]
baron run --recipe <path> [--root <dir>]
baron help
```

Known provider ids: `azure-devops`, `github`.

## `baron init`

Introspect the issues provider, propose a role/type/gap mapping, confirm with you, then write
`.baron/policy.json` and scaffold `.baron/credentials.example` (+ a `.gitignore` entry for
`.baron/credentials`).

| Flag | Meaning |
| --- | --- |
| `--provider <id>` | **Required.** Provider to bind to the `issues` port. |
| `--root <dir>` | Project root (default `.`). |
| `--force` | Overwrite an existing `policy.json` without prompting. |

Missing `--provider` exits `2`. Declining the confirmation writes nothing and exits `0`.

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
