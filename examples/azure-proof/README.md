# Example: azure-proof — a full single-pane policy

A reference `.baron/policy.json` showing Baron driving the **whole loop from one provider set**:
Azure DevOps for `issues` + `scm` + `ci` + `deploy`, and Slack for `notify`. The role/type map is
modelled on a customized **Scrum** process (states `New / Active / Test / Closed`, types
`Epic / Product Backlog Item / Task`) — the same shape the BeeMaster dogfood validated live.

It is a **reference**, not a runnable project: it has no real repo or credentials. Use it to see how
a complete policy is shaped, then generate your own with `baron init` against your real project (which
introspects the live states and proposes the role map for you to confirm).

## What it binds

| Port     | Provider      | Notes |
| -------- | ------------- | ----- |
| `issues` | azure-devops  | role map: `backlog→New`, `in_progress→Active`, `in_review→Test`, `done→Closed` |
| `scm`    | azure-devops  | branches + PRs; base branch defaults to the repo default when omitted |
| `ci`     | azure-devops  | Azure Pipelines; `RunStatus` normalized, per-stage status, logs |
| `deploy` | azure-devops  | Azure Environments; `DeployStatus` normalized |
| `notify` | slack         | `baron_notify_send` to a channel / thread |

`ci` and `deploy` reuse the same Azure DevOps credentials as `issues`/`scm` — there are no extra env
keys, and no `baron init` step for them (their status maps are vendor-fixed adapter knowledge).

## Using it

```bash
# Copy the policy into your project and adapt the org/project/repo coordinates via credentials.
cp -r examples/azure-proof/.baron <your-project>/.baron
cp examples/azure-proof/.baron/credentials.example <your-project>/.baron/credentials   # then fill it in

# Validate the role/type map against your live Azure DevOps project:
baron doctor --root <your-project>

# Or regenerate the map from scratch for your project:
baron init --provider azure-devops --root <your-project>
```

Credentials live in `.baron/credentials` (gitignored) or the environment — never in `policy.json`.
