---
description: Run a Baron recipe (declarative YAML workflow) against the policy's live ports.
argument-hint: <recipe-path>
---

Run the Baron recipe at `$ARGUMENTS` against the providers bound in `.baron/policy.json`.

Execute:

```
baron run --recipe $ARGUMENTS
```

The recipe's `ask` steps prompt for any inputs; `do` steps invoke issue/scm primitives; `message`
steps report progress. If `.baron/policy.json` is missing, run `baron init` first. Surface any
`BaronError` code (e.g. `CAPABILITY_GAP`, `POLICY_NOT_FOUND`) to the user with the actionable hint
from its message rather than retrying blindly.
