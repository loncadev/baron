---
name: task-land
description: >-
  Land a work item's pull request with Baron — take it out of draft and merge it. Use when the user
  says merge it / land it / birleştir / it's approved, ship this PR. Do NOT shell out to `gh` or
  `az` for this; Baron owns the provider call, including the parts that have no REST route.
---

# Land a task (merge the PR)

The last mile of the daily loop: `task-new → task-start → task-finish → **task-land**`. One
deterministic recipe call does the whole landing — undraft, then merge.

**Never fall back to `gh pr merge` / `az repos pr update`.** Baron has the primitives, and going
around it means the merge happens outside the run the user can audit. If Baron refuses, the refusal
is the answer — report it, don't route around it.

## Steps

1. **Identify the work item**: parse the current branch (`git rev-parse --abbrev-ref HEAD`) as
   `<prefix>/<id>-<slug>`. If the branch doesn't match, ask which item to land — never merge a PR
   you inferred.
2. **Check before you merge** — call `baron_scm_pr_for_branch`, then `baron_scm_pr_status` on the
   PR it returns. Read three things and say them out loud:
   - **checks** (`rollup`) — `failed` or `pending` means STOP and ask, rather than merging red or
     unfinished. `unknown` means Baron could not read CI at all (a fine-grained GitHub token cannot
     be granted the Checks permission, and without `Actions: Read` + `Commit statuses: Read` there is
     no way in; Azure PR policies are not read either). Report `unknown` as unknown and let the user
     decide — it is NOT `none`, which means the provider was asked and there is genuinely no CI.
   - **reviewDecision** — `changes_requested` means STOP. `review_required` is the user's call.
   - **mergeable** — false usually means conflicts; the fix is a local rebase, not a retry.

   If anything is red or ambiguous, ask with `AskUserQuestion` before proceeding. A merge is hard to
   take back.
3. **Ask how it should land** (`AskUserQuestion`, one question, only if the user didn't already say):
   *"Merge strategy?"* → **Squash** / **Merge commit** / **Rebase** / **Provider default**. Offer
   deleting the source branch in the same question if the repo doesn't do it automatically.
4. **Run the recipe** — call `baron_recipe_run` exactly once:

   ```json
   { "name": "task-land", "inputs": { "issueId": "<id>", "strategy": "squash", "deleteSourceBranch": "yes" } }
   ```

   Leave `strategy` out to take the provider's own default. The recipe undrafts only if the PR is
   actually a draft, then merges.
5. **Report honestly**:
   - The merge commit and the PR URL.
   - **What happened to the item.** A PR opened with a native closing link (GitHub `Closes #N`)
     closes its item on merge — it is already in `done`, nothing more to do. Where the link does not
     close (Azure `AB#N`), the item **stays where it was**; offer `task-move` to settle it. The
     recipe reports the role and native state it read back, so quote those rather than guessing.
     It also **reconciles** after the merge: on a label-keyed provider the role label Baron wrote at
     task-start would otherwise survive the close and keep the board showing finished work as
     in-flight. If the provider had not closed the item yet when the run finished, reconcile no-ops
     and `task-sync` picks it up — say so instead of claiming the board is clean.
   - Then `git checkout <default-branch> && git pull` locally so the user isn't left on a merged
     branch.

## When Baron refuses

`MERGE_FAILED` is a real answer, not a hiccup — the provider declined. Common causes: unmet branch
policy or required reviewers, failing required checks, conflicts, or a PR that is still a draft on a
provider that won't merge drafts. Report the provider's message verbatim and what would unblock it.
Do not retry the same merge, and do not switch to the CLI to force it through.

## Multiple PRs

Asked to land several in order? Resolve the order from the dependency between them (a PR whose base
is another PR's branch lands after it), then run `task-land` once per item, checking status between
runs — an earlier merge can turn a later PR red or conflicting.
