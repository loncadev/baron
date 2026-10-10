<!-- baron:begin — managed by `baron init`; edit outside these markers -->
## Work tracking — route through Baron

Track work through **Baron**, not raw provider writes: it normalizes issues and source control across
providers behind one contract, so speak its abstract vocabulary, never a vendor's native states.

- **Roles, not native states.** Move work by role: `backlog → ready → in_progress → in_review → done`,
  plus `blocked`. Say "move it to in_progress", never "set the state to Active" — Baron maps the
  role to the provider.
- **Type roles this policy maps:** `initiative`, `epic`, `story`, `task`, `bug`, `subtask`.
  Asking for one it does not map is an error, not a degrade — that list is what `issue.create`
  accepts here.
- **Tools:** `baron_issue_*` (create / get / update / transition / comment / assign / link / query),
  `baron_scm_*` (branch / PR), `baron_recipe_run`, and `baron_learning_*` / `baron_followup_*` for
  durable decisions and follow-ups.
- **Daily loop — prefer the skills:** `/baron:task-new` (create), `/baron:task-start <id>` (cut the
  canonical branch, move to in_progress, assign you), `/baron:task-finish` (draft PR),
  `/baron:task-land` (undraft + merge — never `gh`/`az`), `/baron:task-move`,
  `/baron:task-list`, `/baron:task-sync`. Each item's canonical branch is Baron-derived — use it
  verbatim, never invent one.
- Reading/exploring a provider natively is fine, but make every work-item **change** through Baron so the
  role mapping, gap policy, and knowledge loop apply.

**On this project (provider: `github`):** roles ride labels (Baron provisions `in-progress` / `in-review` / `done`); sprints are NOT available — sprint queries degrade to empty. That empty is expected here, not a bug;
parent/child is emulated via a `parent:<id>` label. Where a capability is missing Baron negotiates it (error / emulate /
degrade) and logs it — an empty or emulated result from a degraded capability is expected behavior,
not a silent failure to report as a bug.
<!-- baron:end -->
