import type { CapabilityManifest } from './capabilities.js';
import type { NativeTarget, TypeMap } from './config.js';
import type {
  IntrospectedState,
  IntrospectedType,
  ProviderIntrospection,
  StateCategory,
} from './introspection.js';
import type { PolicyRoleMapEntry } from './policy-file.js';
import {
  TYPE_ROLE_COLLAPSE_ORDER,
  WORK_ITEM_TYPE_ROLES,
  type WorkItemTypeRole,
  type WorkflowRole,
} from './roles.js';

/**
 * A draft policy for one provider, produced from introspection for a human to confirm. Every fuzzy
 * or skipped decision is recorded in `notes` so `baron init` can surface exactly what it guessed —
 * the proposal is never silently authoritative (decision #4: introspected + human-confirmed).
 */
export interface ProviderProposal {
  readonly provider: string;
  readonly roleMap: PolicyRoleMapEntry;
  readonly typeMap: TypeMap;
  /** On-disk gap-behavior strings ('emulate:labels' | 'degrade' | ...), keyed by capability. */
  readonly gapPolicy: Record<string, string>;
  readonly notes: readonly string[];
}

/** Which native state category each workflow role is drawn from on a rich provider. */
const ROLE_CATEGORY: Partial<Record<WorkflowRole, StateCategory>> = {
  backlog: 'proposed',
  in_progress: 'in_progress',
  in_review: 'resolved',
  done: 'completed',
};

/** Keyword probes for matching a board column to a role (English defaults; a human confirms). */
const COLUMN_KEYWORDS: Partial<Record<WorkflowRole, RegExp>> = {
  in_progress: /progress|doing|active|develop/i,
  in_review: /review|test|qa|verify/i,
  done: /done|closed|complete|resolved/i,
};

/** Keyword probes for matching a native work-item type to a type role. */
const TYPE_KEYWORDS: Record<WorkItemTypeRole, RegExp> = {
  initiative: /initiative|theme/i,
  // 'Feature' is a portfolio level above the story-level backlog item — treat it as epic, NOT story,
  // so Scrum's 'Product Backlog Item' wins the story role instead of losing it to 'Feature'.
  epic: /epic|feature/i,
  story: /story|backlog item|pbi|requirement/i,
  task: /^task$|task|to-?do/i,
  bug: /bug|defect|incident/i,
  subtask: /sub-?task/i,
};

/**
 * Name probe for an `in_review` state when the provider has no `resolved`-category state. Many Azure
 * processes (e.g. a customized Scrum with a 'Test' state) put review in an InProgress-category state,
 * which the category-only match would miss.
 */
const REVIEW_STATE_NAME = /test|review|qa|verif/i;

/** "Sub-task", "Subtask" and "sub task" are one name; so are "Task" and "task". */
function normalizeTypeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/** The type a provider files below every other, by the level it reports or, failing that, its name. */
function isSubtaskType(type: IntrospectedType): boolean {
  return (
    (type.hierarchyLevel !== undefined && type.hierarchyLevel > 0) ||
    TYPE_KEYWORDS.subtask.test(type.name)
  );
}

function firstStateByCategory(
  states: readonly IntrospectedState[],
  category: StateCategory,
): string | undefined {
  return states.find((s) => s.category === category)?.name;
}

function matchColumn(columns: readonly string[], probe: RegExp): string | undefined {
  return columns.find((c) => probe.test(c));
}

/**
 * Propose a role map from introspection. Branches on the provider's capability manifest — the heart
 * of the impedance bet: a rich provider (arbitrary states) draws each role from a native state by
 * category and attaches a board column when one is found; a flat provider rides mid-workflow roles
 * on labels and closes the issue for `done`.
 */
export function proposeRoleMap(
  introspection: ProviderIntrospection,
  manifest: CapabilityManifest,
): { entry: PolicyRoleMapEntry; notes: string[] } {
  const notes: string[] = [];

  if (manifest.issues.arbitraryStates) {
    const stateKey = introspection.stateKey;

    // A provider whose states are SCOPED proposes one map per scope, not one map. Linear forces it:
    // `WorkflowState.team` is non-null, so "In Progress" names a different row in every team and a
    // single flat map would be some team's states imposed on all of them. The matching itself is
    // unchanged — each scope runs exactly the rules an unscoped provider runs, which is the point of
    // splitting the input rather than the logic.
    const scopeNames = [
      ...new Set(
        introspection.states
          .map((state) => state.scope)
          .filter((scope): scope is string => scope !== undefined),
      ),
    ];
    if (scopeNames.length > 0) {
      const scopes: Record<string, Partial<Record<WorkflowRole, NativeTarget>>> = {};
      for (const scope of scopeNames) {
        const own = introspection.states.filter((state) => state.scope === scope);
        const matched = matchStates(own, stateKey, manifest, introspection, notes, scope);
        if (Object.keys(matched).length > 0) scopes[scope] = matched;
        else notes.push(`Scope '${scope}' matched no roles and was left out; confirm its states.`);
      }
      notes.push(
        `States are scoped on '${introspection.provider}', so the map is per scope ` +
          `(${scopeNames.join(', ')}). A role can legitimately exist in one scope and not another.`,
      );
      return { entry: { stateKey, states: {}, scopes }, notes };
    }

    const states = matchStates(introspection.states, stateKey, manifest, introspection, notes);
    return { entry: { stateKey, states }, notes };
  }

  return proposeFlatRoleMap(introspection, notes);
}

/**
 * Match every role onto one of `available`, by the provider's own state categories.
 *
 * Split out so a scoped provider runs it once per scope with that scope's states, and an unscoped
 * one runs it once with all of them — the same rules either way. `scope` is only used to say which
 * map a note is about.
 */
function matchStates(
  available: readonly IntrospectedState[],
  stateKey: string,
  manifest: CapabilityManifest,
  introspection: ProviderIntrospection,
  notes: string[],
  scope?: string,
): Partial<Record<WorkflowRole, NativeTarget>> {
  const states: Partial<Record<WorkflowRole, NativeTarget>> = {};
  const where = scope === undefined ? '' : ` in scope '${scope}'`;
  {
    const used = new Set<string>();
    for (const [role, category] of Object.entries(ROLE_CATEGORY) as [
      WorkflowRole,
      StateCategory,
    ][]) {
      const candidates = available.filter((s) => !used.has(s.name) && s.category === category);
      // A provider with only three categories (Jira: To Do / In Progress / Done) files its review
      // state under in_progress too, and lists states in no particular order — so the first
      // in_progress-category state can be "In Review", which then takes the in_progress role and
      // leaves in_review with nothing. Prefer a state that does not READ as review; fall back to any.
      let matched =
        role === 'in_progress'
          ? (candidates.find((s) => !REVIEW_STATE_NAME.test(s.name)) ?? candidates[0])
          : candidates[0];
      // Fallback for in_review: a process may have no 'resolved'-category state but a review state
      // (e.g. 'Test') in the InProgress category — match it by name, not reusing another role's state.
      if (matched === undefined && role === 'in_review') {
        const named = available.find(
          (s) =>
            !used.has(s.name) &&
            s.category !== 'completed' &&
            s.category !== 'removed' &&
            REVIEW_STATE_NAME.test(s.name),
        );
        if (named !== undefined) {
          matched = named;
          notes.push(
            `Mapped role 'in_review' to state '${named.name}'${where} by name (no 'resolved'-` +
              'category state found); confirm it.',
          );
        }
      }
      if (matched === undefined) {
        notes.push(
          `No '${category}'-category state found for role '${role}'${where}; left unmapped.`,
        );
        continue;
      }
      used.add(matched.name);
      // `value` when the provider gives one, the name otherwise. Linear supplies a state id because
      // its names collide across teams; Azure and GitHub have nothing to supply and the name IS the
      // identity there.
      const target: NativeTarget = { [stateKey]: matched.value ?? matched.name };
      if (manifest.issues.separateBoardColumn && introspection.boardColumns) {
        const probe = COLUMN_KEYWORDS[role];
        const column = probe ? matchColumn(introspection.boardColumns, probe) : undefined;
        if (column !== undefined) {
          target.boardColumn = column;
          notes.push(`Matched board column '${column}' to role '${role}' by keyword; confirm it.`);
        }
      }
      states[role] = target;
    }
  }
  return states;
}

/**
 * A provider with no arbitrary states: mid-workflow roles are emulated on labels and `done` closes
 * the issue, so the discriminator is the label rather than the native state.
 */
function proposeFlatRoleMap(
  introspection: ProviderIntrospection,
  notes: string[],
): { entry: PolicyRoleMapEntry; notes: string[] } {
  const states: Partial<Record<WorkflowRole, NativeTarget>> = {};
  const doneState = firstStateByCategory(introspection.states, 'completed');
  states.in_progress = { label: 'in-progress' };
  states.in_review = { label: 'in-review' };
  states.done = doneState ? { state: doneState, label: 'done' } : { label: 'done' };
  notes.push(
    `Provider '${introspection.provider}' has no arbitrary states; mid-workflow roles are ` +
      'proposed as labels and emulated. backlog/ready/blocked are left unmapped — add if needed.',
  );
  if (doneState === undefined) {
    notes.push("No 'completed'-category state found; 'done' will not close the issue natively.");
  }
  return { entry: { stateKey: 'label', states }, notes };
}

/**
 * Propose a type map from introspection. A provider with a single native type (GitHub without Issue
 * Types) collapses every type role onto it; a provider with many types matches each role by keyword
 * and then FILLS the gaps, because a hole in this map is not a harmless omission.
 *
 * Two failures come from an incomplete map, and this repository produced both. A role nothing maps
 * to makes `issue.create` refuse it while `AGENTS.md` advertises it. Worse, a native type nothing
 * maps FROM leaves every item reporting it with no type role and therefore no canonical branch —
 * which is why `task-start` once refused every issue here: the org had Task/Bug/Feature defined,
 * keyword matching claimed those three, and the plain 'issue' that all twelve issues actually
 * reported was mapped by nobody.
 *
 * So unmatched roles land on the provider's default type when it declares one, and otherwise borrow
 * from their nearest neighbour ({@link TYPE_ROLE_COLLAPSE_ORDER}). Both are lossy, both are noted,
 * and a role that still cannot be placed is reported rather than quietly dropped.
 */
export function proposeTypeMap(introspection: ProviderIntrospection): {
  typeMap: TypeMap;
  notes: string[];
} {
  const notes: string[] = [];
  const typeMap: Record<string, string> = {};
  const types = introspection.workItemTypes;

  if (types.length === 1) {
    const only = types[0]?.name;
    if (only !== undefined) {
      for (const role of WORK_ITEM_TYPE_ROLES) {
        typeMap[role] = only;
      }
      notes.push(
        `Provider '${introspection.provider}' exposes one native type ('${only}'); all type ` +
          'roles collapse onto it (reverse type-role resolution is lossy).',
      );
    }
    return { typeMap: typeMap as TypeMap, notes };
  }

  const unmatched: WorkItemTypeRole[] = [];
  for (const role of WORK_ITEM_TYPE_ROLES) {
    // A type NAMED for the role wins outright: Jira lists "Subtask" before "Task", and the keyword
    // probe for `task` matches both, so keyword order alone handed `task` to the sub-task type.
    // Failing that, a sub-task-level type is never a candidate for any other role — it is the one
    // type every provider agrees sits below the rest.
    const match =
      types.find((t) => normalizeTypeName(t.name) === role) ??
      types.find(
        (t) => TYPE_KEYWORDS[role].test(t.name) && (role === 'subtask' || !isSubtaskType(t)),
      );
    if (match !== undefined) typeMap[role] = match.name;
    else unmatched.push(role);
  }

  const defaultType = types.find((t) => t.isDefault === true)?.name;
  for (const role of unmatched) {
    if (defaultType !== undefined) {
      typeMap[role] = defaultType;
      notes.push(
        `No native type matched type role '${role}'; mapped onto '${defaultType}', the type an ` +
          'item reports when none is set. Reverse resolution for that type is lossy.',
      );
      continue;
    }
    const borrowed = TYPE_ROLE_COLLAPSE_ORDER[role]
      .map((from) => typeMap[from])
      .find((native): native is string => native !== undefined);
    if (borrowed !== undefined) {
      typeMap[role] = borrowed;
      notes.push(
        `No native type matched type role '${role}'; collapsed onto '${borrowed}'. Items of that ` +
          'native type no longer resolve back to a single role.',
      );
    } else {
      notes.push(
        `No native type matched type role '${role}', and no neighbouring role is mapped either — ` +
          `it is left unmapped. \`issue.create\` with typeRole '${role}' will fail until you map it.`,
      );
    }
  }

  // A native type nothing maps FROM is the other half of coverage, and the one that costs items
  // their branch. Report it; the human confirming the proposal is the only one who can judge
  // whether that type is in use.
  for (const type of types) {
    if (Object.values(typeMap).includes(type.name)) continue;
    notes.push(
      `Native type '${type.name}' is mapped from no type role; items reporting it will have no ` +
        'type role and therefore no canonical branch.',
    );
  }

  return { typeMap: typeMap as TypeMap, notes };
}

/**
 * Propose a gap policy from the manifest: every unsupported capability gets an explicit behavior so
 * the gap is never silent. Hierarchy and arbitrary states are emulated via labels; sprints and
 * sub-issues degrade with a warning. A human can override any of these.
 */
export function proposeGapPolicy(manifest: CapabilityManifest): {
  gapPolicy: Record<string, string>;
  notes: string[];
} {
  const notes: string[] = [];
  const gapPolicy: Record<string, string> = {};
  const caps = manifest.issues;

  if (!caps.hierarchy) gapPolicy.hierarchy = 'emulate:labels';
  if (!caps.arbitraryStates) gapPolicy.arbitraryStates = 'emulate:labels';
  if (!caps.issueLinks) gapPolicy.issueLinks = 'emulate:labels';
  if (!caps.sprints) gapPolicy.sprints = 'degrade';
  // Post-filtering is the only honest emulation: the alternative is returning items of every type
  // to a caller that asked for one, which is what this capability exists to stop.
  if (!caps.typeFiltering) gapPolicy.typeFiltering = 'emulate:post-filter';
  if (!caps.subIssues) gapPolicy.subIssues = 'degrade';
  if (!caps.comments) gapPolicy.comments = 'degrade';

  if (!caps.nativeLabels && (gapPolicy.hierarchy || gapPolicy.arbitraryStates)) {
    notes.push(
      `Provider '${manifest.provider}' lacks native labels but label emulation was proposed; ` +
        'review the gap policy — emulation may not be viable.',
    );
  }
  return { gapPolicy, notes };
}

/** Assemble a full per-provider {@link ProviderProposal} from introspection plus its manifest. */
export function proposePolicy(
  introspection: ProviderIntrospection,
  manifest: CapabilityManifest,
): ProviderProposal {
  const role = proposeRoleMap(introspection, manifest);
  const type = proposeTypeMap(introspection);
  const gap = proposeGapPolicy(manifest);
  return {
    provider: introspection.provider,
    roleMap: role.entry,
    typeMap: type.typeMap,
    gapPolicy: gap.gapPolicy,
    notes: [...role.notes, ...type.notes, ...gap.notes],
  };
}
